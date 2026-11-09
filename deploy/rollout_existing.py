#!/usr/bin/env python3
"""Update the existing beta API without resetting its runtime configuration.

Requires authenticated gcloud (Google Cloud Shell is suitable). No mutation
unless --apply is supplied. Never reads Secret Manager payloads or changes IAM.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT_NUMBER = "451179869201"
SERVICE = "seensnap-api-staging"
REGION = "us-central1"
JOB = SERVICE + "-migrate"
REQUIRED_ROUTES = {
    "/api/v1/me/stories": "get",
    "/api/v1/me/stories/{story_id}": "get",
    "/api/v1/me/discovery-resume": "post",
    "/api/v1/me/onboarding-draft": "put",
    "/api/v1/me/title-compatibility": "post",
    "/api/v1/discover/collection/{key}": "get",
    "/api/v1/lists/{list_id}": "get",
    "/api/v1/teams/{team_id}/home/{section}": "get",
    "/api/v1/teams/{team_id}/titles/{title_id}/my-state": "put",
    "/api/v1/media-assets/{asset_id}/source": "get",
    "/api/v1/me/picks/collections/{category}": "get",
    "/api/v1/me/concierge/decision/{decision_id}": "get",
    "/api/v1/me/concierge/requests/{request_key}": "get",
    "/api/v1/titles/recommendations/feed": "get",
    "/api/v1/notifications/{notification_id}/open": "post",
    "/api/v1/social/posts/{post_id}": "get",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(*args):
    # Captured descriptions can contain environment values; never log them.
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    require(result.returncode == 0,
            f"Command failed: {' '.join(args[:4])}. Check this operation in Cloud Console; "
            "raw output is withheld because it can include runtime configuration.")
    return result.stdout.strip()


def cloud(project, *args):
    return json.loads(command("gcloud", *args, f"--project={project}", "--format=json", "--quiet"))


def describe_service(project):
    return cloud(project, "run", "services", "describe", SERVICE, f"--region={REGION}")


def describe_job(project):
    return cloud(project, "run", "jobs", "describe", JOB, f"--region={REGION}")


def traffic(service):
    allocations = {}
    for item in service["status"].get("traffic", []):
        if item.get("percent", 0):
            revision = item.get("revisionName")
            require(revision, "Cannot resolve the serving revision. Stop and inspect Cloud Run.")
            allocations[revision] = allocations.get(revision, 0) + item["percent"]
    require(sum(allocations.values()) == 100, "Cannot establish the current traffic allocation.")
    return allocations


def validate(service, job, project):
    template = service["spec"]["template"]
    containers = template["spec"]["containers"]
    job_spec = job["spec"]["template"]["spec"]
    job_template = job_spec["template"]
    job_containers = job_template["spec"]["containers"]
    require(len(containers) == len(job_containers) == 1,
            "Multi-container configuration needs an explicit rollout review.")
    require(job_spec.get("taskCount", 1) == 1 and job_spec.get("parallelism", 1) == 1,
            "Migration job must execute one task.")
    worker = job_containers[0]
    require(worker.get("command") == ["alembic"] and worker.get("args") == ["upgrade", "head"],
            "Existing migration job must run exactly alembic upgrade head.")
    env = {e["name"]: e for e in containers[0].get("env", [])}
    job_env = {e["name"]: e for e in worker.get("env", [])}
    require("DATABASE_URL" in env and env["DATABASE_URL"] == job_env.get("DATABASE_URL"),
            "API and migration job DATABASE_URL references differ; verify their database before rollout.")
    def configured(name):
        value = env.get(name, {})
        return bool(value.get("value") or value.get("valueFrom"))
    require(configured("TMDB_API_KEY"), "TMDB_API_KEY is not configured on the existing service.")
    provider = env.get("CONCIERGE_AI_PROVIDER", {}).get("value", "").strip().lower()
    require(provider in {"vertex", "anthropic", "openai"},
            "Set a supported CONCIERGE_AI_PROVIDER explicitly on Cloud Run before rollout.")
    if provider == "vertex":
        require(any(configured(k) for k in (
            "CONCIERGE_AI_PROJECT", "GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT")),
            "Vertex requires its existing project configuration; this script does not invent it.")
    else:
        require(configured("CONCIERGE_AI_API_KEY"), "The selected Concierge provider needs its API key configured.")
    connections = template.get("metadata", {}).get("annotations", {}).get("run.googleapis.com/cloudsql-instances", "")
    job_connections = job_template.get("metadata", {}).get("annotations", {}).get("run.googleapis.com/cloudsql-instances", "")
    require(connections and connections == job_connections and "," not in connections,
            "API and migration job must have the same single Cloud SQL attachment.")
    parts = connections.split(":")
    require(len(parts) == 3 and parts[0] in {project, PROJECT_NUMBER},
            "Cloud SQL attachment is outside the verified project.")
    image_repo = containers[0]["image"].split("@")[0].split(":")[0]
    require(re.fullmatch(r"[a-z0-9-]+-docker\.pkg\.dev/[^/]+/[^/]+/[^: @]+", image_repo),
            "Existing image must be in Artifact Registry; inspect other registry setups manually.")
    require(image_repo.split("/")[1] in {project, PROJECT_NUMBER}, "Image repository is outside the verified project.")
    traffic(service)
    return image_repo, parts[2]


def probe(url):
    require(url.startswith("https://") and url.split("/")[2].endswith(".run.app"),
            "Unexpected Cloud Run probe URL.")
    for path in ("/health", "/openapi.json"):
        with urllib.request.urlopen(url.rstrip("/") + path, timeout=30) as response:
            data = json.load(response)
        if path == "/health":
            require(data.get("status") == "ok", "API health check failed.")
        else:
            for route, method in REQUIRED_ROUTES.items():
                require(method in data.get("paths", {}).get(route, {}),
                        f"New API route is missing: {method.upper()} {route}")


def rollout(project, before, job, commit, image_repo, instance):
    suffix = f"beta-{commit[:10]}-{int(time.time())}"
    revision = f"{SERVICE}-{suffix}"
    tag = suffix
    old_traffic = traffic(before)
    rollback = ",".join(f"{name}={percent}" for name, percent in sorted(old_traffic.items()))
    print(f"Rollback traffic command: gcloud run services update-traffic {SERVICE} "
          f"--region={REGION} --project={project} --to-revisions={rollback}", flush=True)

    # Upload only committed API files, excluding untracked local secrets/uploads.
    with tempfile.TemporaryDirectory(prefix="seensnap-build-") as temporary:
        archive = Path(temporary) / "api.tar.gz"
        with archive.open("wb") as output:
            subprocess.run(["git", "archive", "--format=tar.gz", f"{commit}:apps/api"],
                           cwd=ROOT, stdout=output, check=True)
        image_tag = f"{image_repo}:{suffix}"
        print("Building the committed API with Cloud Build (may take several minutes).", flush=True)
        build = cloud(project, "builds", "submit", str(archive), f"--tag={image_tag}")
    require(build.get("status") == "SUCCESS", "Cloud Build did not succeed.")
    images = build.get("results", {}).get("images", [])
    digest = next((i.get("digest", "") for i in images if i.get("name") == image_tag), "")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest), "Cloud Build did not return the expected immutable image digest.")
    image = f"{image_repo}@{digest}"
    # Abort on concurrent changes rather than overwriting another deployment.
    require(describe_service(project)["spec"] == before["spec"], "Service changed during build. Rerun preflight.")
    require(describe_job(project)["spec"] == job["spec"], "Migration job changed during build. Rerun preflight.")
    print("Backing up Cloud SQL before migration.", flush=True)
    cloud(project, "sql", "backups", "create", f"--instance={instance}", f"--description=Before {suffix}")
    print("Updating the existing migration job image and waiting for successful migration.", flush=True)
    cloud(project, "run", "jobs", "update", JOB, f"--region={REGION}", f"--image={image}")
    cloud(project, "run", "jobs", "execute", JOB, f"--region={REGION}", "--wait")
    require(describe_service(project)["spec"] == before["spec"], "Service changed during migration. Stop and inspect before deployment.")
    print("Deploying a revision with no production traffic; existing settings are retained.", flush=True)
    cloud(project, "run", "deploy", SERVICE, f"--region={REGION}", f"--image={image}",
          "--no-traffic", f"--tag={tag}", f"--revision-suffix={suffix}")
    candidate = describe_service(project)
    require(traffic(candidate) == old_traffic, "Traffic changed unexpectedly. Stop and inspect Cloud Run.")
    require(candidate["status"].get("latestReadyRevisionName") == revision,
            "The expected new revision is not ready.")
    tagged_url = next((t.get("url") for t in candidate["status"].get("traffic", []) if
                       t.get("tag") == tag and t.get("revisionName") == revision), None)
    require(tagged_url, "No URL found for the exact candidate revision.")
    probe(tagged_url)
    require(describe_service(project)["spec"] == candidate["spec"], "Service changed during checks. Stop before traffic promotion.")
    print("Structural API checks passed; switching traffic to the exact checked revision.", flush=True)
    cloud(project, "run", "services", "update-traffic", SERVICE, f"--region={REGION}",
          f"--to-revisions={revision}=100")
    live = describe_service(project)
    require(traffic(live) == {revision: 100}, "Traffic promotion did not finish as expected.")
    probe(live["status"]["url"])
    print(json.dumps({"backend_commit": commit, "revision": revision, "image": image,
                      "api_base_url": live["status"]["url"] + "/api/v1",
                      "migration": "completed", "structural_checks": "passed",
                      "live_concierge_and_device_acceptance": "still required",
                      "netlify_production": "unchanged; merge PR only after live acceptance"}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Back up, migrate, deploy, check and promote the API")
    parser.add_argument("--expected-commit", help="Exact reviewed Git SHA; required with --apply")
    args = parser.parse_args()
    commit = command("git", "rev-parse", "HEAD")
    require(not command("git", "status", "--porcelain", "--untracked-files=no"), "Tracked worktree must be clean.")
    if args.apply:
        require(args.expected_commit == commit, "--apply requires --expected-commit matching the reviewed checkout SHA.")
    project_data = json.loads(command("gcloud", "projects", "describe", PROJECT_NUMBER, "--format=json"))
    require(str(project_data["projectNumber"]) == PROJECT_NUMBER, "Unexpected Google Cloud project.")
    project = project_data["projectId"]
    service, job = describe_service(project), describe_job(project)
    image_repo, instance = validate(service, job, project)
    print(f"Preflight passed: project={project}, service={SERVICE}, commit={commit}", flush=True)
    print("Configuration presence checked only; provider credentials/model access still require a live account test.", flush=True)
    if args.apply:
        rollout(project, service, job, commit, image_repo, instance)
    else:
        print("Read-only check complete. No cloud resources changed. Use --apply --expected-commit <reviewed SHA> to deploy.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Avoid echoing environment-bearing subprocess outputs or URL contents.
        message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(f"STOPPED: {message}\nDo not merge the frontend until backend rollout and live acceptance pass.", file=sys.stderr)
        sys.exit(1)
