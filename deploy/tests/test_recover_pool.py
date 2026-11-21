"""Recovery promotion must depend on DB health and unchanged configuration."""
import copy
from io import BytesIO
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).parents[1]))
import recover_pool as recovery


def states():
    old = "seensnap-api-staging-old"
    new = "seensnap-api-staging-pool-recovery-100"
    before = {"spec": {"template": {"metadata": {"name": old}, "spec": {
        "containerConcurrency": 80, "serviceAccountName": "keep-this-account",
        "containers": [{"image": recovery.IMAGE, "env": [
            {"name": "SEENSNAP_RELEASE_COMMIT", "value": recovery.COMMIT},
            {"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": "db", "key": "latest"}}}
        ]}]}}}, "status": {"latestCreatedRevisionName": old, "latestReadyRevisionName": old,
        "url": "https://live.run.app", "traffic": [{"revisionName": old, "percent": 100}]}}
    candidate = copy.deepcopy(before)
    candidate["spec"]["template"]["metadata"]["name"] = new
    candidate["spec"]["template"]["spec"]["containerConcurrency"] = 4
    candidate["status"].update(latestCreatedRevisionName=new, latestReadyRevisionName=new)
    candidate["status"]["traffic"].append({"revisionName": new, "tag": "pool-recovery-100", "url": "https://candidate.run.app"})
    live = copy.deepcopy(candidate)
    live["status"]["traffic"] = [{"revisionName": new, "percent": 100}]
    return before, candidate, live


class RecoveryTests(unittest.TestCase):
    def invoke(self, resources, *, apply=True, probe_error=None):
        with patch.object(recovery.rollout, "cloud", return_value={"projectNumber": recovery.rollout.PROJECT_NUMBER}), \
             patch.object(recovery.rollout, "describe_service", side_effect=resources), \
             patch.object(recovery.rollout, "cloud_action") as action, \
             patch.object(recovery, "probe_database", side_effect=probe_error) as probe, \
             patch.object(recovery.time, "time", return_value=100):
            try:
                recovery.recover(apply=apply)
                error = None
            except RuntimeError as caught:
                error = caught
            return action.call_args_list, probe.call_args_list, error

    def test_default_is_read_only(self):
        before, _, _ = states()
        actions, probes, error = self.invoke([before], apply=False)
        self.assertIsNone(error)
        self.assertEqual(actions, [])
        self.assertEqual(probes, [])

    def test_success_checks_exact_candidate_and_live_database(self):
        before, candidate, live = states()
        actions, probes, error = self.invoke([before, before, candidate, candidate, live])
        self.assertIsNone(error)
        self.assertEqual(len(actions), 2)
        self.assertIn("--no-traffic", actions[0].args)
        self.assertIn("--concurrency=4", actions[0].args)
        self.assertIn("--to-revisions=seensnap-api-staging-pool-recovery-100=100", actions[1].args)
        self.assertEqual([p.args[0] for p in probes], ["https://candidate.run.app", "https://live.run.app"])

    def test_database_failure_never_promotes(self):
        before, candidate, _ = states()
        actions, _, error = self.invoke([before, before, candidate], probe_error=RuntimeError("DB failed"))
        self.assertEqual(len(actions), 1)
        self.assertIsNotNone(error)

    def test_settings_change_never_promotes(self):
        before, candidate, _ = states()
        candidate["spec"]["template"]["spec"]["serviceAccountName"] = "unexpected"
        actions, probes, error = self.invoke([before, before, candidate])
        self.assertEqual(len(actions), 1)
        self.assertEqual(probes, [])
        self.assertIsNotNone(error)

    def test_concurrent_update_never_promotes(self):
        before, candidate, _ = states()
        changed = copy.deepcopy(candidate)
        changed["spec"]["template"]["spec"]["containerConcurrency"] = 20
        actions, _, error = self.invoke([before, before, candidate, changed])
        self.assertEqual(len(actions), 1)
        self.assertIsNotNone(error)

    def test_unknown_image_or_pending_revision_never_changes_service(self):
        for kind in ("image", "pending"):
            before, _, _ = states()
            if kind == "image":
                before["spec"]["template"]["spec"]["containers"][0]["image"] = "different"
            else:
                before["status"]["latestCreatedRevisionName"] = "pending"
            actions, _, error = self.invoke([before])
            self.assertEqual(actions, [])
            self.assertIsNotNone(error)

    def test_process_health_alone_is_not_enough(self):
        health = {"status": "ok", "revision": "r", "commit": recovery.COMMIT}
        for code, body in ((500, {"detail": "error"}), (404, {"detail": "Not Found"})):
            responses = [BytesIO(json.dumps(health).encode()), HTTPError("https://api.run.app", code, "error", {}, BytesIO(json.dumps(body).encode()))]
            with patch.object(recovery, "urlopen", side_effect=responses):
                with self.assertRaises(RuntimeError):
                    recovery.probe_database("https://api.run.app", "r")

    def test_expected_title_404_proves_handler_reached_database(self):
        health = {"status": "ok", "revision": "r", "commit": recovery.COMMIT}
        responses = [BytesIO(json.dumps(health).encode())] + [HTTPError("https://api.run.app", 404, "missing", {}, BytesIO(b'{"detail":"Title not found"}')) for _ in range(2)]
        with patch.object(recovery, "urlopen", side_effect=responses) as request:
            recovery.probe_database("https://api.run.app", "r")
            self.assertEqual(request.call_count, 3)


if __name__ == "__main__":
    unittest.main()
