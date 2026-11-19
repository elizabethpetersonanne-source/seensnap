# Build 4 — Cloud Shell release steps

The app changes are committed at `949fb9d3927081adc4dcc279f49df8a720f15f5d` on `codex/build4-prelaunch` (PR #19). GitHub Actions passed the backend, mobile/web and deployment-safety checks. This update is a TestFlight candidate; actual iPhone/iPad acceptance and the missing published legal pages remain outstanding.

## 1. Deploy the backend improvement

Paste the complete block into the same Google Cloud Shell account/project used for previous releases. Leave it running through the final JSON result. Do not restart while a rollout is in progress.

```bash
(
set -e
cd ~/seensnap-release
git fetch origin codex/build4-prelaunch
SEENSNAP_RELEASE=949fb9d3927081adc4dcc279f49df8a720f15f5d
git checkout --detach "$SEENSNAP_RELEASE"
SEENSNAP_LOG=$(mktemp "$HOME/seensnap-rollout-XXXXXX.log")
nohup python3 -u deploy/rollout_existing.py \
  --apply \
  --expected-commit "$SEENSNAP_RELEASE" \
  > "$SEENSNAP_LOG" 2>&1 < /dev/null &
tail --pid=$! -f "$SEENSNAP_LOG"
)
```

The final output must report the expected backend commit, completed migration and passed structural checks. A `STOPPED` message is not a successful deployment. Live signed-in acceptance is still required.

## 2. Upload the new iOS build to Apple

Expo has confirmed **Succeeded**, version **1.0.0 (4)**, for build `7ece279c-40ae-466e-a87a-cb74314f5ab8`. This is the new candidate, not the previously uploaded build 3. The command uses your existing private key file without printing it and restores `eas.json` afterward.

```bash
(
set -e
cd ~/seensnap-release/apps/mobile
python3 - <<'PY'
import json
import subprocess
from pathlib import Path

key = Path.home() / "AuthKey_H7XZT5CV9U.p8"
if not key.is_file():
    raise SystemExit("Apple key file is missing from your Cloud Shell home folder.")

path = Path("eas.json")
original = path.read_bytes()
config = json.loads(original)
ios = config["submit"]["testflight"]["ios"]
if str(ios.get("ascAppId")) != "6835181142" or ios.get("appleTeamId") != "7Z8CYNB749":
    raise SystemExit("Unexpected Apple app or team. Stop and check the release checkout.")
ios.update({
    "ascApiKeyPath": str(key),
    "ascApiKeyId": "H7XZT5CV9U",
    "ascApiKeyIssuerId": "5c35dec5-62d7-48b8-9eff-f636ea07ad2a"
})
try:
    path.write_text(json.dumps(config, indent=2) + "\n")
    subprocess.run([
        "npx", "--yes", "eas-cli@latest", "submit",
        "--platform", "ios", "--profile", "testflight",
        "--id", "7ece279c-40ae-466e-a87a-cb74314f5ab8",
        "--non-interactive", "--no-wait", "--no-auto-testflight-setup"
    ], check=True)
finally:
    path.write_bytes(original)
PY
)
```

“Scheduled iOS submission” means the upload is queued, not yet accepted by Apple. Check the returned submission link, then App Store Connect → SeenSnap → TestFlight. Add the processed new build to the intended tester group. The updated icon appears with the new installed build; this does not replace the binary/icon of an older build.

## Device checks before broader release

- Swipe slowly and quickly in all four directions, cancel short/diagonal drags, test Undo, and retry a failed save. The card must not snap to center before exiting or save twice.
- Preview must start muted on a fresh launch, retain an explicit sound choice across trailers, stop immediately when leaving, and retain position/sound through Expand → rotate → Done.
- Reopen profile edits, saved/watched collections, rankings moved beyond the first page, and two-account Watch Team sharing.
- Publish the approved Terms and Privacy documents (the current `.app/terms` and `.app/privacy` paths return 404) and complete real-device acceptance before public release.

This release process does not update Netlify production automatically.
