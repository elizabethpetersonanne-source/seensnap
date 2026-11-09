"""Regression checks for rollout failure boundaries; no cloud credentials used."""
import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("rollout", Path(__file__).parents[1] / "rollout_existing.py")
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)
PROJECT = "verified-project"
IMAGE = f"us-central1-docker.pkg.dev/{PROJECT}/seensnap/api"
COMMIT = "a" * 40
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

    def execute(self, failure=None):
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
                return {"status": "SUCCESS", "results": {"images": [{"name": IMAGE + ":" + suffix, "digest": "sha256:" + "b" * 64}]}}
            if failure == "backup" and args[:3] == ("sql", "backups", "create"):
                raise RuntimeError("backup failed")
            if failure == "migration" and args[:3] == ("run", "jobs", "execute"):
                raise RuntimeError("migration failed")
            return {}

        def probe(url):
            calls.append(("probe", url))
            if failure == "probe":
                raise RuntimeError("candidate probe failed")

        with patch.object(rollout, "cloud", side_effect=cloud), \
             patch.object(rollout, "describe_service", side_effect=[service, service, candidate, candidate, live]), \
             patch.object(rollout, "describe_job", return_value=job), \
             patch.object(rollout, "probe", side_effect=probe), \
             patch.object(rollout.time, "time", return_value=123), \
             patch.object(rollout.subprocess, "run"), patch("builtins.print"):
            if failure:
                with self.assertRaises(RuntimeError):
                    rollout.rollout(PROJECT, service, job, COMMIT, IMAGE, "beta-db")
            else:
                rollout.rollout(PROJECT, service, job, COMMIT, IMAGE, "beta-db")
        return calls

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
