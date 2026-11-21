#!/usr/bin/env python3
"""Restart the verified Build 4 API with bounded request concurrency.

No builds, migrations, secret reads, IAM changes, or SQL instance changes.
Candidate traffic remains at zero until an actual database read succeeds.
This mitigates pool exhaustion; it does not diagnose every connection holder.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import urlopen

import rollout_existing as rollout

PROJECT = "seensnap-staging"
COMMIT = "949fb9d3927081adc4dcc279f49df8a720f15f5d"
IMAGE = ("us-central1-docker.pkg.dev/seensnap-staging/seensnap/seensnap-api@sha256:"
         "b78b44dffe1bd2b8f143b1bfd88b6e24f14b6a2df2a920552ab4e41a9077d1f7")
DB_PROBE = "/api/v1/titles/00000000-0000-0000-0000-000000000000?enrich=false&include_related=false"


def normalized_template(template):
    result = copy.deepcopy(template)
    metadata = result.get("metadata", {})
    metadata.pop("name", None)
    annotations = metadata.get("annotations", {})
    for key in ("run.googleapis.com/client-name", "run.googleapis.com/client-version",
                "client.knative.dev/user-image"):
        annotations.pop(key, None)
    return result


def probe_database(url, revision):
    parsed = urlsplit(url)
    rollout.require(parsed.scheme == "https" and (parsed.hostname or "").endswith(".run.app")
                    and not parsed.username and not parsed.password and not parsed.query,
                    "Unexpected probe URL.")
    with urlopen(url.rstrip("/") + "/health", timeout=12) as response:
        health = json.load(response)
    rollout.require(health.get("status") == "ok" and health.get("commit") == COMMIT
                    and health.get("revision") == revision, "Unexpected API release in health response.")
    # The verified route performs a DB primary-key lookup before returning this
    # exact 404. No authentication, mutations, providers, or enrichment involved.
    for _ in range(2):
        started = time.monotonic()
        try:
            with urlopen(url.rstrip("/") + DB_PROBE, timeout=12):
                raise RuntimeError("Unexpected success for nonexistent title probe.")
        except HTTPError as error:
            with error:
                rollout.require(error.code == 404, f"Database read failed with HTTP {error.code}.")
                rollout.require(json.load(error) == {"detail": "Title not found"},
                                "Database probe did not reach the expected title handler.")
        rollout.require(time.monotonic() - started < 12, "Database read exceeded the recovery deadline.")
    print("Two real database reads passed.", flush=True)


def recover(*, apply=False):
    project = rollout.cloud(PROJECT, "projects", "describe", PROJECT)
    rollout.require(str(project.get("projectNumber")) == rollout.PROJECT_NUMBER,
                    "Unexpected Google Cloud project.")
    before = rollout.describe_service(PROJECT)
    allocation = rollout.traffic(before)
    rollout.require(len(allocation) == 1, "Split traffic requires a separate recovery review.")
    old_revision = next(iter(allocation))
    rollout.require(before["status"].get("latestCreatedRevisionName") == old_revision
                    and before["status"].get("latestReadyRevisionName") == old_revision,
                    "A different candidate revision already exists. Stop and inspect it first.")
    spec = before["spec"]["template"]["spec"]
    containers = spec.get("containers", [])
    rollout.require(len(containers) == 1 and containers[0].get("image") == IMAGE,
                    "The service image has changed from the reviewed Build 4 image.")
    release = next((e.get("value") for e in containers[0].get("env", [])
                    if e.get("name") == "SEENSNAP_RELEASE_COMMIT"), None)
    rollout.require(release == COMMIT, "Unexpected backend release.")
    concurrency = min(4, int(spec.get("containerConcurrency", 80)))
    rollout.require(concurrency >= 1, "Unsupported concurrency configuration.")
    print(f"Current per-instance concurrency: {spec.get('containerConcurrency', 80)}; "
          f"recovery concurrency: {concurrency}.", flush=True)
    print(f"Rollback command: gcloud run services update-traffic {rollout.SERVICE} "
          f"--project={PROJECT} --region={rollout.REGION} --to-revisions={old_revision}=100", flush=True)
    if not apply:
        print("Read-only preflight passed. Use --apply to create and check a recovery revision.")
        return
    rollout.require(rollout.describe_service(PROJECT)["spec"] == before["spec"],
                    "Service changed during preflight.")
    suffix = f"pool-recovery-{int(time.time())}"
    revision = f"{rollout.SERVICE}-{suffix}"
    print("Starting the same API image with lower concurrency and no traffic. Leave this running.", flush=True)
    rollout.cloud_action(PROJECT, "run", "services", "update", rollout.SERVICE,
                         f"--region={rollout.REGION}", f"--concurrency={concurrency}",
                         f"--revision-suffix={suffix}", f"--tag={suffix}", "--no-traffic")
    candidate = rollout.describe_service(PROJECT)
    expected = normalized_template(before["spec"]["template"])
    expected["spec"]["containerConcurrency"] = concurrency
    rollout.require(normalized_template(candidate["spec"]["template"]) == expected,
                    "Candidate changed settings other than concurrency. Traffic has not been promoted.")
    rollout.require(rollout.traffic(candidate) == allocation
                    and candidate["status"].get("latestReadyRevisionName") == revision
                    and candidate["status"].get("latestCreatedRevisionName") == revision,
                    "Traffic or revision changed unexpectedly. Stop and inspect Cloud Run.")
    url = next((item.get("url") for item in candidate["status"].get("traffic", [])
                if item.get("tag") == suffix and item.get("revisionName") == revision), None)
    rollout.require(url, "Candidate has no verified tagged URL.")
    probe_database(url, revision)
    current = rollout.describe_service(PROJECT)
    rollout.require(current["spec"] == candidate["spec"] and rollout.traffic(current) == allocation,
                    "Service changed during database checks. Traffic has not been promoted.")
    print("Candidate database checks passed; switching traffic to that exact revision.", flush=True)
    rollout.cloud_action(PROJECT, "run", "services", "update-traffic", rollout.SERVICE,
                         f"--region={rollout.REGION}", f"--to-revisions={revision}=100")
    live = rollout.describe_service(PROJECT)
    rollout.require(rollout.traffic(live) == {revision: 100}, "Traffic promotion did not complete.")
    probe_database(live["status"]["url"], revision)
    print(json.dumps({"recovery": "database_reads_passed", "revision": revision,
                      "backend_commit": COMMIT, "concurrency": concurrency,
                      "testflight_relaunch": "required to verify native recovery",
                      "root_cause": "connection-holder investigation still required"}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        recover(apply=args.apply)
    except Exception as error:
        # Never expose captured cloud settings, SQL text, or secret values.
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"STOPPED: {detail}. Check the last completed step above before retrying.", file=sys.stderr)
        sys.exit(1)
