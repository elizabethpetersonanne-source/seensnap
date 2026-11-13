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
    # A heartbeat reports only the command family, never its captured output.
    label = " ".join(args[:3]) if args[0] == "gcloud" else Path(args[0]).name
    started = time.monotonic()
    with subprocess.Popen(args, cwd=ROOT, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        while True:
            try:
                stdout, _stderr = process.communicate(timeout=20)
                break
            except subprocess.TimeoutExpired:
                elapsed = int(time.monotonic() - started)
                print(f"Waiting for {label} ({elapsed}s elapsed). Leave this command running.", flush=True)
        returncode = process.returncode
    require(returncode == 0,
            f"Command failed: {label}. Check this operation in Cloud Console; "
            "raw output is withheld because it can include runtime configuration.")
    return stdout.strip()


def cloud(project, *args):
    raw = command("gcloud", *args, f"--project={project}", "--format=json", "--quiet")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(
            f"Could not read structured output from gcloud {' '.join(args[:2])}. "
            "The operation may have completed; inspect its status in Cloud Console before retrying. "
            "Raw output is withheld because it may include runtime configuration."
        ) from None
    require(isinstance(result, dict), f"Unexpected resource response from gcloud {' '.join(args[:2])}.")
    return result


def cloud_action(project, *args):
    # These synchronous commands are checked for success, but their output
    # is not a resource we consume. Empty output must not become a JSON error.
    command("gcloud", *args, f"--project={project}", "--format=json", "--quiet")


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


def validate(service, job, project, concierge_override=None):
    template = service["spec"]["template"]
    containers = template["spec"]["containers"]
    execution_template = job["spec"]["template"]
    job_spec = execution_template["spec"]
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
        model = (concierge_override or {}).get("CONCIERGE_AI_MODEL") or env.get("CONCIERGE_AI_MODEL", {}).get("value") or "gemini-3.5-flash-lite"
        location = (concierge_override or {}).get("CONCIERGE_AI_LOCATION") or env.get("CONCIERGE_AI_LOCATION", {}).get("value") or "us"
        require(not model.startswith(("gemini-2.5-flash", "gemini-2.5-pro")),
                "The configured Gemini 2.5 text model is retired. Supply --concierge-model gemini-3.5-flash-lite --concierge-location us to update it on the new revision.")
        if model in {"gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"}:
            require(location in {"us", "eu", "global"}, "This Gemini model needs a supported multi-region/global endpoint. Supply --concierge-location with --concierge-model.")
    else:
        require(not concierge_override, "Concierge model/location overrides here are only for the existing Vertex provider.")
        require(configured("CONCIERGE_AI_API_KEY"), "The selected Concierge provider needs its API key configured.")
    connections = template.get("metadata", {}).get("annotations", {}).get("run.googleapis.com/cloudsql-instances", "")
    # Cloud Run v1 stores job Cloud SQL annotations on the execution
    # template, not the nested task template containing the containers.
    # https://docs.cloud.google.com/run/docs/reference/yaml/v1#job
    job_connections = execution_template.get("metadata", {}).get("annotations", {}).get("run.googleapis.com/cloudsql-instances", "")
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


def build_image(build, image_repo, image_tag):
    require(build.get("status") == "SUCCESS", "Cloud Build did not succeed.")
    images = [i for i in build.get("results", {}).get("images", []) if i.get("name") == image_tag]
    require(len(images) == 1, "Cloud Build did not return exactly one expected image result.")
    digest = images[0].get("digest", "")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest), "Cloud Build did not return the expected immutable image digest.")
    return f"{image_repo}@{digest}"


def reusable_build(project, commit, image_repo, build_id, build_commit):
    """Read an operator-identified build from an earlier rollout attempt.

    The operator supplies the build ID from that attempt's Cloud Build history.
    The recorded image tag identifies its source commit; identical Git API
    trees permit deployment-tool-only fixes without another application build.
    Never resolve a mutable registry tag or pick an arbitrary latest build.
    """
    require(re.fullmatch(r"[a-f0-9-]{36}", build_id), "Expected an exact Cloud Build ID.")
    require(re.fullmatch(r"[a-f0-9]{40}", build_commit), "--build-commit must be the full source commit SHA.")
    command("git", "merge-base", "--is-ancestor", build_commit, commit)
    source_tree = command("git", "rev-parse", f"{build_commit}:apps/api")
    reviewed_tree = command("git", "rev-parse", f"{commit}:apps/api")
    require(source_tree == reviewed_tree,
            "The earlier build's API source differs from the reviewed checkout. A fresh build is required.")
    print(f"Checking completed Cloud Build {build_id} and its immutable image.", flush=True)
    build = cloud(project, "builds", "describe", build_id)
    require(build.get("id") == build_id and build.get("projectId") == project,
            "The build response does not match the requested build/project.")
    tags = build.get("images", [])
    pattern = re.escape(f"{image_repo}:beta-{build_commit[:10]}-") + r"[0-9]+"
    require(len(tags) == 1 and re.fullmatch(pattern, tags[0]),
            "The build image does not match the earlier rollout's source commit and existing repository.")
    image = build_image(build, image_repo, tags[0])
    print("Earlier build succeeded; its API source matches this checkout. No new build is needed.", flush=True)
    return {"id": build_id, "commit": build_commit, "api_tree": source_tree, "image": image}


def rollout(project, before, job, commit, image_repo, instance, reuse=None, concierge_override=None):
    suffix = f"beta-{commit[:10]}-{int(time.time())}"
    revision = f"{SERVICE}-{suffix}"
    tag = suffix
    old_traffic = traffic(before)
    rollback = ",".join(f"{name}={percent}" for name, percent in sorted(old_traffic.items()))
    print(f"Rollback traffic command: gcloud run services update-traffic {SERVICE} "
          f"--region={REGION} --project={project} --to-revisions={rollback}", flush=True)

    if reuse:
        image = reuse["image"]
        backend_commit = reuse["commit"]
        build_id = reuse["id"]
        print(f"Reusing completed build {build_id}; proceeding to backup and migration.", flush=True)
    else:
        # Upload only committed API files, excluding untracked local secrets/uploads.
        with tempfile.TemporaryDirectory(prefix="seensnap-build-") as temporary:
            archive = Path(temporary) / "api.tar.gz"
            with archive.open("wb") as output:
                subprocess.run(["git", "archive", "--format=tar.gz", f"{commit}:apps/api"],
                               cwd=ROOT, stdout=output, check=True)
            image_tag = f"{image_repo}:{suffix}"
            print("Building the committed API with Cloud Build (may take several minutes).", flush=True)
            # Build logs stream to stdout even when --format=json is requested.
            # Suppress the log stream so stdout contains only the Build resource.
            # https://docs.cloud.google.com/sdk/gcloud/reference/builds/submit
            build = cloud(project, "builds", "submit", str(archive), f"--tag={image_tag}", "--suppress-logs")
        image = build_image(build, image_repo, image_tag)
        backend_commit = commit
        build_id = build.get("id")
    # Abort on concurrent changes rather than overwriting another deployment.
    require(describe_service(project)["spec"] == before["spec"], "Service changed during build. Rerun preflight.")
    require(describe_job(project)["spec"] == job["spec"], "Migration job changed during build. Rerun preflight.")
    print("Backing up Cloud SQL before migration.", flush=True)
    cloud_action(project, "sql", "backups", "create", f"--instance={instance}", f"--description=Before {suffix}")
    print("Updating the existing migration job image and waiting for successful migration.", flush=True)
    cloud_action(project, "run", "jobs", "update", JOB, f"--region={REGION}", f"--image={image}")
    cloud_action(project, "run", "jobs", "execute", JOB, f"--region={REGION}", "--wait")
    require(describe_service(project)["spec"] == before["spec"], "Service changed during migration. Stop and inspect before deployment.")
    print("Deploying a revision with no production traffic; existing settings are retained.", flush=True)
    release_env = {**(concierge_override or {}), "SEENSNAP_RELEASE_COMMIT": backend_commit}
    overrides = ["--update-env-vars=" + ",".join(f"{key}={value}" for key, value in sorted(release_env.items()))]
    cloud_action(project, "run", "deploy", SERVICE, f"--region={REGION}", f"--image={image}",
          "--no-traffic", f"--tag={tag}", f"--revision-suffix={suffix}", *overrides)
    candidate = describe_service(project)
    if concierge_override:
        configured = {e["name"]: e.get("value") for e in candidate["spec"]["template"]["spec"]["containers"][0].get("env", [])}
        require(all(configured.get(k) == v for k, v in concierge_override.items()), "Candidate Concierge configuration did not match the requested update.")
    require(traffic(candidate) == old_traffic, "Traffic changed unexpectedly. Stop and inspect Cloud Run.")
    require(candidate["status"].get("latestReadyRevisionName") == revision,
            "The expected new revision is not ready.")
    tagged_url = next((t.get("url") for t in candidate["status"].get("traffic", []) if
                       t.get("tag") == tag and t.get("revisionName") == revision), None)
    require(tagged_url, "No URL found for the exact candidate revision.")
    probe(tagged_url)
    require(describe_service(project)["spec"] == candidate["spec"], "Service changed during checks. Stop before traffic promotion.")
    print("Structural API checks passed; switching traffic to the exact checked revision.", flush=True)
    cloud_action(project, "run", "services", "update-traffic", SERVICE, f"--region={REGION}",
          f"--to-revisions={revision}=100")
    live = describe_service(project)
    require(traffic(live) == {revision: 100}, "Traffic promotion did not finish as expected.")
    probe(live["status"]["url"])
    print(json.dumps({"backend_commit": backend_commit, "rollout_commit": commit,
                      "build_id": build_id, "revision": revision, "image": image,
                      "api_base_url": live["status"]["url"] + "/api/v1",
                      "migration": "completed", "structural_checks": "passed",
                      "live_concierge_and_device_acceptance": "still required",
                      "netlify_production": "unchanged; merge PR only after live acceptance"}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Back up, migrate, deploy, check and promote the API")
    parser.add_argument("--expected-commit", help="Exact reviewed Git SHA; required with --apply")
    parser.add_argument("--reuse-build", help="Exact successful Cloud Build ID from a previous rollout attempt")
    parser.add_argument("--build-commit", help="Full source commit of --reuse-build; API files must match this checkout")
    parser.add_argument("--concierge-model", help="Explicit Vertex model update on the new revision only")
    parser.add_argument("--concierge-location", help="Vertex endpoint location for --concierge-model (for example us)")
    args = parser.parse_args()
    require(bool(args.concierge_model) == bool(args.concierge_location), "Supply --concierge-model and --concierge-location together.")
    concierge_override = None
    if args.concierge_model:
        require(re.fullmatch(r"[a-z0-9.-]+", args.concierge_model) and re.fullmatch(r"[a-z0-9-]+", args.concierge_location), "Invalid model or endpoint location.")
        concierge_override = {"CONCIERGE_AI_MODEL": args.concierge_model, "CONCIERGE_AI_LOCATION": args.concierge_location}
    require(bool(args.reuse_build) == bool(args.build_commit), "Supply --reuse-build and --build-commit together.")
    commit = command("git", "rev-parse", "HEAD")
    require(not command("git", "status", "--porcelain", "--untracked-files=no"), "Tracked worktree must be clean.")
    if args.apply:
        require(args.expected_commit == commit, "--apply requires --expected-commit matching the reviewed checkout SHA.")
    print("Checking the existing Google Cloud project.", flush=True)
    project_data = cloud(PROJECT_NUMBER, "projects", "describe", PROJECT_NUMBER)
    require(str(project_data["projectNumber"]) == PROJECT_NUMBER, "Unexpected Google Cloud project.")
    project = project_data["projectId"]
    print("Reading the existing API service.", flush=True)
    service = describe_service(project)
    print("Reading the existing migration job.", flush=True)
    job = describe_job(project)
    image_repo, instance = validate(service, job, project, concierge_override=concierge_override)
    print(f"Preflight passed: project={project}, service={SERVICE}, commit={commit}", flush=True)
    print("Configuration presence checked only; provider credentials/model access still require a live account test.", flush=True)
    reuse = reusable_build(project, commit, image_repo, args.reuse_build, args.build_commit) if args.reuse_build else None
    if args.apply:
        rollout(project, service, job, commit, image_repo, instance, reuse=reuse, concierge_override=concierge_override)
    else:
        print("Read-only check complete. No cloud resources changed. Use --apply --expected-commit <reviewed SHA> to deploy.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nINTERRUPTED: The local deployment command was stopped. Check Cloud Build/Cloud Run status before retrying; "
              "a cloud operation may still exist. Keep the frontend unmerged.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        # Avoid echoing environment-bearing subprocess outputs or URL contents.
        message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print(f"STOPPED: {message}\nDo not merge the frontend until backend rollout and live acceptance pass.", file=sys.stderr)
        sys.exit(1)
