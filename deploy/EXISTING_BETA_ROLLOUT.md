# Deploy the completed beta batch

## Verified current state (November 8, 2026)

- Live web: https://seensnapalpha.netlify.app/
- Review web: https://deploy-preview-1--seensnapalpha.netlify.app/
- The live web bundle targets `https://seensnap-api-staging-451179869201.us-central1.run.app/api/v1`.
- That API reports healthy/staging but does not expose the new collection pagination or current Concierge decision endpoints. The backend batch is not live.
- PR #1 is ready for review, unmerged: https://github.com/elizabethpetersonanne-source/seensnap/pull/1
- No authenticated Google Cloud deployment session is available in the implementation workspace. An automatic deployment review blocked merging the frontend before its backend/migration dependency.

Netlify builds only the web app. Deploy the API/database first; then verify the preview against the updated backend and merge PR #1 to publish the web changes. This batch does not complete all outstanding brief requirements. See `docs/BETA_IMPLEMENTATION_STATUS_2026-11-08.md`.

## Backend command

Use an authenticated Google Cloud Shell or an existing authorized deployment terminal. No credentials should be pasted into chat. The operator needs existing permissions for Cloud Build, the service's Artifact Registry repository, Cloud SQL backup, the Cloud Run service/migration job and their existing service accounts. This script does not create roles, accounts, secrets or infrastructure.

In a clean checkout, fetch PR #1 and inspect its exact commit and passing CI before applying:

```sh
git fetch origin pull/1/head
git checkout --detach FETCH_HEAD
git log -1 --oneline
python3 deploy/rollout_existing.py
```

The default is read-only. It resolves project number `451179869201` to the real project ID, inspects `seensnap-api-staging` in `us-central1`, and verifies the existing `seensnap-api-staging-migrate` job points to the same database and runs `alembic upgrade head`. It also requires a configured TMDB key and Concierge provider. Presence checks do not prove credentials, model access or quota work.

If you checked out `3ebc5df` and the preflight reported "API and migration job must have the same single Cloud SQL attachment," fetch the updated PR before changing cloud configuration. That revision incorrectly read the job annotation from the task template. Cloud Run v1 stores it at `spec.template.metadata.annotations`, on the execution template. The corrected checker still rejects missing, different or multiple attachments and requires matching database references. Rerun the read-only check on the new commit; an actual configuration mismatch must still be investigated. This correction changes deployment tooling only, not the application or migrations.

If preflight passes and this is the reviewed commit:

```sh
python3 deploy/rollout_existing.py --apply --expected-commit "$(git rev-parse HEAD)"
```

The command uploads only committed API files, builds an immutable image, takes a Cloud SQL backup, updates only the migration job's image and waits for the migration. It then deploys the API image with no live traffic, checks `/health` and new routes on the exact tagged revision, and promotes that revision. It preserves existing environment variables, secret references, service accounts and Cloud SQL connections. A failure stops the sequence. Existing users continue using the old API while the new revision is prepared; the reviewed migrations through `20261108_0042` remove a ranking limit and add discovery history/session tables plus Concierge request receipts, explicitly shared team states, durable bounded media assets, rating revision tombstones and owner-only onboarding drafts. They are additive for the old API. Old releases will not write the new discovery ledger: deploy the new API promptly after migration; do not claim complete discovery history across that transition.

The command prints a traffic rollback command before changes and a final report containing commit, revision and image digest. Save that report. Do not use the older `deploy_staging.sh` bootstrap as an update command: it sets complete environment/secret lists and deploys the service before migration.

If the preflight stops, inspect the named configuration in Cloud Console rather than skipping the check. In particular, verify the intended Concierge provider/model and its existing authentication. The rollout script does not select a new provider or change its configuration.

If revision `2eb6f84` stopped with `JSONDecodeError` immediately after "Building the committed API," the build command may have succeeded, but its streamed logs contaminated the JSON response. That stop occurs before database backup, migration or deployment. Inspect recent builds with `gcloud builds list --project=seensnap-staging --limit=3 --sort-by=~createTime --format='table(id,status,createTime,images)'` (using the same Cloud Shell build-region setting as the failed attempt). Fetch the updated PR before retrying. Build submission now uses `--suppress-logs`; resource reads still require valid structured output and a successful build with an exact image digest. Synchronous mutations whose output is unused are checked for command success without trying to decode an empty response. A retry builds the reviewed source again; it does not adopt an unverified old image. Existing backup, migration and traffic gates remain in place.

### Continue after a successful build and interrupted local rollout

The operator's Cloud Build listing confirmed `cda1b727-58d4-4b8b-9c76-4f6590930471` succeeded for source commit `2eb6f84c42df56e494ff87ea090cd5716a5d100b`. The later attempt `3aba218a-8d56-48cb-945c-4d64ca336285` was cancelled during build. Neither reported attempt reached database backup, migration or deployment. The successful source commit and the later deployment-tool fixes have the identical `apps/api` tree, `edfce79202318dbe32b79c04b3f001c8035d7342`.

An explicit `--reuse-build BUILD_ID --build-commit FULL_SOURCE_SHA` can reuse a build identified from this rollout history. The script checks that the source commit is an ancestor of the reviewed checkout, that every API/Docker/migration file matches, and that the exact project/build has status SUCCESS, the expected repository/source tag, and one valid immutable image digest. It never selects the latest build automatically or resolves a mutable registry tag. Supply these flags without `--apply` for a read-only check. Reuse with `--apply --expected-commit REVIEWED_SHA` skips only source upload/build; all configuration, backup, migration, candidate and traffic checks remain. The final report distinguishes the original backend source commit from the current deployment-tool commit. An arbitrary build ID or tag is not source attestation; use the operator-identified build from the earlier rollout, not an unrelated externally built image.

For this confirmed successful build, append:

```sh
--reuse-build cda1b727-58d4-4b8b-9c76-4f6590930471 \
--build-commit 2eb6f84c42df56e494ff87ea090cd5716a5d100b
```

Preflight now announces each read. Long-running commands print a safe waiting message every 20 seconds without exposing captured configuration. Leave the command running through backups and migrations. If interrupted, inspect cloud operation status before another attempt; the script does not automatically roll back a database or assume that stopping the local process stopped a remote operation.

## Verify and finish Netlify

1. Sign into the deploy preview using a beta account. Verify actor requests, Comedy TV, a personal Next Watch request and a request with a streaming provider. Check every returned poster is relevant; no filler is allowed when fewer than five qualify. Check Different Options and Undo. A successful health probe alone does not prove Concierge works.
2. Check rating submit/cancel/edit, all ten choices on iPhone/iPad, ranking pagination/manual moves, append-all, story edit/delete and list delete. Confirm old and new clients remain usable during rollout.
3. Merge the same reviewed PR only after these checks pass. Confirm Netlify's production deploy reports Published for the resulting main commit. Verify its API base remains the Cloud Run `/api/v1` endpoint above; keep private credentials out of Expo public variables.
4. Verify the normal live URL on iPhone/iPad and a fresh browser session. Record the Netlify deploy ID, backend revision and successful account checks. Until then, describe deployment as incomplete.

## Recovery

If a candidate check fails, traffic is not promoted. If a later live check fails, use the printed command to restore the original traffic allocation and keep the frontend PR unmerged. Avoid concurrent deployments while this command runs; it detects configuration changes between stages but cannot lock external operators out of Cloud Run.

Do not automatically downgrade or restore the database. Migration `20261108_0037` retains rankings and its downgrade cannot safely reinstate a 100-title limit after longer rankings exist. `20261108_0038`, `20261108_0039`, `20261108_0040`, `20261108_0041` and `20261108_0042` also refuse automatic downgrade because discovery history and Concierge recovery receipts must be preserved. Database restore would also discard later writes; investigate separately if it is necessary.

## Local verification of the rollout command

```sh
python3 -m unittest discover -s deploy/tests -v
```

These tests verify operation ordering and failure boundaries without cloud access. They do not claim a real Cloud Run deployment or a successful live Concierge request.


Concierge acceptance after this rollout must include `GET /api/v1/me/concierge/requests/{request_key}` (owner authenticated), a lost-response retry returning the same decision, an expired lease resuming safely, Keep looking retaining the source and filters, and a provider failure releasing its allowance. Old API revisions do not create request receipts; only searches started on the updated API have durable initial-request recovery. The receipt lease is 150 seconds and the cooperative work budget is 75 seconds; process restarts require an explicit client retry after the lease expires. Configure log collection for the `seensnap.concierge` JSON messages and inspect stage durations/outcome codes without recording user prompts or credentials.


The list/team/profile continuation also requires the canonical list reader, paginated team sections, explicit team state and protected media routes checked by `rollout_existing.py`. New sanitized photo/bug-report uploads are small database-backed WebP assets (512 KiB maximum); include them in database backup/capacity monitoring. Existing filesystem uploads are not silently converted. New native photo permissions, rotation, tablet support and aligned Expo modules require a fresh native build in addition to the Netlify export. Verify shared links on the real domain and iPhone/iPad uploads/playback before promotion.


The onboarding/rating continuation additionally requires `PUT /api/v1/me/onboarding-draft` and migration `20261108_0041`. On two devices, verify a conflicting draft offers a choice, completion cannot reopen from a stale response, and a stale rating-clear confirmation is rejected after another rating edit. Verify search-to-rate and explicit #1 selection without changing ratings or publishing activity. Review the standardized headers, country selector, keyboard and all ten rating targets at phone/tablet sizes before promotion.

The personalization/Discover continuation requires migration `20261108_0042`, `POST /api/v1/me/title-compatibility` and `GET /api/v1/discover/collection/{key}`. Check two established accounts with different movie/TV tastes, neutral ratings, sparse metadata, no fabricated match percentages, correct source/region through multiple collection pages, and influence corrections after old swipe history is pruned. Historical action versions and corrections already lost before this migration cannot be reconstructed. Review percentages as a beta compatibility index, not a calibrated likelihood of enjoyment.

The story/history and discovery-resume continuation additionally requires `GET /api/v1/me/stories`, `GET /api/v1/me/stories/{story_id}` and `POST /api/v1/me/discovery-resume`. Verify an owner can view and delete retained expired stories while another account cannot read them, and that active stories honor block/profile rules. Test reload after a lost prefetch response, current exclusions and changed region/mode, plus taps versus vertical scrolling on the Swipe detail face. These changes use existing tables and add no migration beyond `20261108_0042`.
