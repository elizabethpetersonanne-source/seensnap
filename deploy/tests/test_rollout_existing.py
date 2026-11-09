"""Regression checks for rollout failure boundaries; no cloud credentials used."""
import copy
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("rollout", Path(__file__).parents[1] / "rollout_existing.py")
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)
PROJECT = "verified-project"
IMAGE = f"us-central1-docker.pkg.dev/{PROJECT}/seensnap/api"
COMMIT = "a" * 40
SOURCE_COMMIT = "c" * 40
BUILD_ID = "cda1b727-58d4-4b8b-9c76-4f6590930471"
SQL = f"{PROJECT}:us-central1:beta-db"
ENV = [
    {"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": "db", "key": "latest"}}},
    {"name": "TMDB_API_KEY", "valueFrom": {"secretKeyRef": {"name": "tmdb", "key": "latest"}}},
    {"name": "CONCIERGE_AI_PROVIDER", "value": "vertex"},
    {"name": "GCP_PROJECT_ID", "value": PROJECT},
]


def fixtures():
    template = {
        "metadata": {"annotations": {"run.googleapis.com/cloudsql-instances": SQL}},
        "spec": {"containers": [{"image": IMAGE + ":old", "env": copy.deepcopy(ENV)}]},
    }
    service = {"spec": {"template": template}, "status": {
        "url": "https://beta.run.app", "traffic": [{"revisionName": "old-revision", "percent": 100}],
    }}
    # Cloud Run v1 Job: execution metadata is separate from the task
    # template. Match the documented API shape, not the Service shape.
    job_template = {"spec": copy.deepcopy(template["spec"])}
    job_template["spec"]["containers"][0].update(command=["alembic"], args=["upgrade", "head"])
    job = {"spec": {"template": {
        "metadata": copy.deepcopy(template["metadata"]),
        "spec": {"taskCount": 1, "parallelism": 1, "template": job_template},
    }}}
    return service, job


class RolloutSafetyTests(unittest.TestCase):
    def test_resource_reader_keeps_valid_json_and_rejects_noisy_output_safely(self):
        build = {"status": "SUCCESS", "id": "test-build"}
        with patch.object(rollout, "command", return_value=json.dumps(build)):
            self.assertEqual(rollout.cloud(PROJECT, "builds", "submit", "archive.tar.gz"), build)
        for raw in ("", "Build log: sensitive-value\n" + json.dumps(build), "null", "[]"):
            with self.subTest(raw=raw), patch.object(rollout, "command", return_value=raw):
                with self.assertRaises(RuntimeError) as raised:
                    rollout.cloud(PROJECT, "builds", "submit", "archive.tar.gz")
                self.assertIn("gcloud builds submit", str(raised.exception))
                self.assertNotIn("sensitive-value", str(raised.exception))

    def test_mutations_accept_empty_success_but_reject_failed_commands(self):
        with patch.object(rollout.subprocess, "Popen") as popen:
            process = popen.return_value.__enter__.return_value
            process.returncode = 0
            process.communicate.return_value = ("", "")
            rollout.cloud_action(PROJECT, "sql", "backups", "create")
            process.returncode = 1
            process.communicate.return_value = ("sensitive-value", "sensitive-value")
            with self.assertRaises(RuntimeError) as raised:
                rollout.cloud_action(PROJECT, "sql", "backups", "create")
            self.assertNotIn("sensitive-value", str(raised.exception))

    def test_slow_command_shows_heartbeat_without_logging_captured_output(self):
        with patch.object(rollout.subprocess, "Popen") as popen, \
             patch.object(rollout.time, "monotonic", side_effect=[100, 120]), \
             patch("builtins.print") as printer:
            process = popen.return_value.__enter__.return_value
            process.returncode = 0
            process.communicate.side_effect = [
                subprocess.TimeoutExpired("gcloud", 20, output="sensitive-value"),
                ('{"status":"SUCCESS"}', "sensitive-value"),
            ]
            self.assertEqual(rollout.command("gcloud", "builds", "describe", BUILD_ID), '{"status":"SUCCESS"}')
            self.assertIn("Waiting for gcloud builds describe (20s elapsed)", printer.call_args.args[0])
            self.assertNotIn("sensitive-value", printer.call_args.args[0])

    def test_command_drains_real_child_stdout_and_stderr(self):
        # Exercise actual pipe handling, not only mocked resource responses.
        result = rollout.command(sys.executable, "-c", "import sys; sys.stderr.write('sensitive-value'); print('ok')")
        self.assertEqual(result, "ok")
        with self.assertRaises(RuntimeError) as raised:
            rollout.command(sys.executable, "-c", "import sys; sys.stderr.write('sensitive-value'); sys.exit(7)")
        self.assertNotIn("sensitive-value", str(raised.exception))

    def previous_build(self):
        tag = f"{IMAGE}:beta-{SOURCE_COMMIT[:10]}-123"
        return {"id": BUILD_ID, "projectId": PROJECT, "status": "SUCCESS", "images": [tag],
                "results": {"images": [{"name": tag, "digest": "sha256:" + "b" * 64}]}}

    def test_reuse_checks_source_ancestry_api_tree_build_project_tag_and_digest(self):
        with patch.object(rollout, "command", side_effect=["", "same-api-tree", "same-api-tree"]) as git, \
             patch.object(rollout, "cloud", return_value=self.previous_build()) as cloud, patch("builtins.print"):
            reuse = rollout.reusable_build(PROJECT, COMMIT, IMAGE, BUILD_ID, SOURCE_COMMIT)
        self.assertEqual(git.call_args_list[0].args, ("git", "merge-base", "--is-ancestor", SOURCE_COMMIT, COMMIT))
        self.assertEqual(cloud.call_args.args, (PROJECT, "builds", "describe", BUILD_ID))
        self.assertEqual(reuse, {"id": BUILD_ID, "commit": SOURCE_COMMIT, "api_tree": "same-api-tree",
                                "image": IMAGE + "@sha256:" + "b" * 64})

    def test_reuse_rejects_different_backend_or_unrelated_source_before_cloud_call(self):
        for responses in (["", "older-api", "reviewed-api"], [RuntimeError("not an ancestor")]):
            with self.subTest(responses=responses), patch.object(rollout, "command", side_effect=responses), \
                 patch.object(rollout, "cloud") as cloud:
                with self.assertRaises(RuntimeError):
                    rollout.reusable_build(PROJECT, COMMIT, IMAGE, BUILD_ID, SOURCE_COMMIT)
                cloud.assert_not_called()

    def test_reuse_rejects_invalid_or_unrelated_build_receipts(self):
        for change in ("id", "project", "cancelled", "running", "wrong-tag", "wrong-repo", "extra-image", "digest", "duplicate-result"):
            with self.subTest(change=change):
                build = self.previous_build()
                if change == "id":
                    build["id"] = "different-build"
                elif change == "project":
                    build["projectId"] = "other-project"
                elif change in {"cancelled", "running"}:
                    build["status"] = "CANCELLED" if change == "cancelled" else "WORKING"
                elif change == "wrong-tag":
                    build["images"] = [IMAGE + ":main"]
                elif change == "wrong-repo":
                    build["images"] = [build["images"][0].replace(IMAGE, IMAGE + "-other")]
                elif change == "extra-image":
                    build["images"].append(IMAGE + ":unreviewed")
                elif change == "digest":
                    build["results"]["images"][0]["digest"] = "not-a-digest"
                else:
                    build["results"]["images"].append(dict(build["results"]["images"][0]))
                with patch.object(rollout, "command", side_effect=["", "same", "same"]), \
                     patch.object(rollout, "cloud", return_value=build), patch("builtins.print"):
                    with self.assertRaises(RuntimeError):
                        rollout.reusable_build(PROJECT, COMMIT, IMAGE, BUILD_ID, SOURCE_COMMIT)

    def test_preflight_accepts_documented_job_execution_attachment(self):
        service, job = fixtures()
        self.assertNotIn("metadata", job["spec"]["template"]["spec"]["template"])
        self.assertEqual(rollout.validate(service, job, PROJECT), (IMAGE, "beta-db"))

    def test_preflight_does_not_accept_attachment_at_wrong_task_level(self):
        service, job = fixtures()
        execution = job["spec"]["template"]
        execution["spec"]["template"]["metadata"] = execution.pop("metadata")
        with self.assertRaisesRegex(RuntimeError, "same single Cloud SQL attachment"):
            rollout.validate(service, job, PROJECT)

    def test_preflight_rejects_missing_or_multiple_actual_attachments(self):
        key = "run.googleapis.com/cloudsql-instances"
        for connection in ("", SQL + "," + PROJECT + ":us-central1:other-db"):
            with self.subTest(connection=connection):
                service, job = fixtures()
                service["spec"]["template"]["metadata"]["annotations"][key] = connection
                job["spec"]["template"]["metadata"]["annotations"][key] = connection
                with self.assertRaisesRegex(RuntimeError, "same single Cloud SQL attachment"):
                    rollout.validate(service, job, PROJECT)

    def test_preflight_rejects_wrong_database_job_or_disabled_concierge(self):
        for change in ("database", "command", "provider", "sql", "parallelism"):
            with self.subTest(change=change):
                service, job = fixtures()
                task = job["spec"]["template"]["spec"]
                worker = task["template"]["spec"]["containers"][0]
                if change == "database":
                    worker["env"][0]["valueFrom"]["secretKeyRef"]["name"] = "different-db"
                elif change == "command":
                    worker["args"] = ["downgrade", "base"]
                elif change == "provider":
                    service["spec"]["template"]["spec"]["containers"][0]["env"][2]["value"] = ""
                elif change == "sql":
                    job["spec"]["template"]["metadata"]["annotations"]["run.googleapis.com/cloudsql-instances"] = "other:region:db"
                else:
                    task["parallelism"] = 2
                with self.assertRaises(RuntimeError):
                    rollout.validate(service, job, PROJECT)

    def execute(self, failure=None, reuse=False):
        service, job = fixtures()
        suffix = "beta-aaaaaaaaaa-123"
        revision = f"{rollout.SERVICE}-{suffix}"
        candidate = copy.deepcopy(service)
        candidate["spec"]["template"]["spec"]["containers"][0]["image"] = IMAGE + "@sha256:" + "b" * 64
        candidate["status"].update(latestReadyRevisionName=revision)
        candidate["status"]["traffic"].append({"tag": suffix, "revisionName": revision, "url": "https://candidate.run.app"})
        live = copy.deepcopy(candidate)
        live["status"]["traffic"] = [{"revisionName": revision, "percent": 100}]
        calls = []

        def cloud(project, *args):
            calls.append(args)
            if args[:2] == ("builds", "submit"):
                self.assertIn("--suppress-logs", args)
                if failure == "build-output":
                    raise RuntimeError("Could not read structured output from gcloud builds submit.")
                return {"status": "FAILURE" if failure == "build" else "SUCCESS", "results": {"images": [{
                    "name": IMAGE + ":" + suffix,
                    "digest": "" if failure == "digest" else "sha256:" + "b" * 64,
                }]}}
            if failure == "backup" and args[:3] == ("sql", "backups", "create"):
                raise RuntimeError("backup failed")
            if failure == "migration" and args[:3] == ("run", "jobs", "execute"):
                raise RuntimeError("migration failed")
            return {}

        def probe(url):
            calls.append(("probe", url))
            if failure == "probe":
                raise RuntimeError("candidate probe failed")

        reuse_receipt = {"id": BUILD_ID, "commit": SOURCE_COMMIT,
                         "image": IMAGE + "@sha256:" + "b" * 64} if reuse else None
        with patch.object(rollout, "cloud", side_effect=cloud), \
             patch.object(rollout, "cloud_action", side_effect=cloud), \
             patch.object(rollout, "describe_service", side_effect=[service, service, candidate, candidate, live]), \
             patch.object(rollout, "describe_job", return_value=job), \
             patch.object(rollout, "probe", side_effect=probe), \
             patch.object(rollout.time, "time", return_value=123), \
             patch.object(rollout.subprocess, "run") as archive, patch("builtins.print"):
            if failure:
                with self.assertRaises(RuntimeError):
                    rollout.rollout(PROJECT, service, job, COMMIT, IMAGE, "beta-db", reuse=reuse_receipt)
            else:
                rollout.rollout(PROJECT, service, job, COMMIT, IMAGE, "beta-db", reuse=reuse_receipt)
            if reuse:
                archive.assert_not_called()
        return calls

    def test_reuse_skips_build_but_retains_backup_migration_and_candidate_gates(self):
        calls = self.execute(reuse=True)
        self.assertFalse(any(a[:2] == ("builds", "submit") for a in calls))
        backup = next(i for i, a in enumerate(calls) if a[:3] == ("sql", "backups", "create"))
        migration = next(i for i, a in enumerate(calls) if a[:3] == ("run", "jobs", "execute"))
        deployment = next(i for i, a in enumerate(calls) if a[:2] == ("run", "deploy"))
        probe = next(i for i, a in enumerate(calls) if a[0] == "probe")
        promote = next(i for i, a in enumerate(calls) if a[:3] == ("run", "services", "update-traffic"))
        self.assertTrue(backup < migration < deployment < probe < promote)
        for failure in ("backup", "migration", "probe"):
            with self.subTest(failure=failure):
                failed = self.execute(failure=failure, reuse=True)
                self.assertFalse(any(a[:3] == ("run", "services", "update-traffic") for a in failed))

    def test_build_failure_bad_output_or_missing_digest_prevents_database_changes(self):
        for failure in ("build", "build-output", "digest"):
            with self.subTest(failure=failure):
                calls = self.execute(failure)
                self.assertFalse(any(a[0] in {"run", "sql"} for a in calls))

    def test_success_backs_up_then_migrates_then_checks_before_traffic(self):
        calls = self.execute()
        operations = [args[:3] for args in calls]
        backup = operations.index(("sql", "backups", "create"))
        migration = operations.index(("run", "jobs", "execute"))
        deployment = next(i for i, a in enumerate(calls) if a[:2] == ("run", "deploy"))
        probe = next(i for i, a in enumerate(calls) if a[0] == "probe")
        promote = operations.index(("run", "services", "update-traffic"))
        self.assertTrue(backup < migration < deployment < probe < promote)
        self.assertIn("--no-traffic", calls[deployment])
        for args in calls:
            self.assertFalse(any(a.startswith(("--set-env", "--clear-env", "--set-secrets", "--clear-secrets", "--allow-unauthenticated")) for a in args))
        self.assertIn("--wait", calls[migration])
        self.assertIn(f"--to-revisions={rollout.SERVICE}-beta-aaaaaaaaaa-123=100", calls[promote])

    def test_backup_failure_prevents_migration_and_deployment(self):
        calls = self.execute("backup")
        self.assertFalse(any(a[0] == "run" for a in calls))

    def test_migration_failure_prevents_service_deployment(self):
        calls = self.execute("migration")
        self.assertFalse(any(a[:2] == ("run", "deploy") for a in calls))

    def test_candidate_failure_prevents_traffic_promotion(self):
        calls = self.execute("probe")
        self.assertFalse(any(a[:3] == ("run", "services", "update-traffic") for a in calls))


if __name__ == "__main__":
    unittest.main()
