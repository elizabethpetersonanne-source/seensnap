"""Apply public per-build values to the committed iOS project. No credentials."""
import os
from pathlib import Path
import plistlib
import re

path = Path(__file__).resolve().parents[1] / "ios/SeenSnap/Info.plist"
with path.open("rb") as f:
    info = plistlib.load(f)
client_id = os.environ.get("EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID", "")
if client_id and not re.fullmatch(r"[\w-]+\.apps\.googleusercontent\.com", client_id):
    raise SystemExit("Invalid iOS Google OAuth client ID")
types = [entry for entry in info.get("CFBundleURLTypes", []) if entry.get("CFBundleURLName") != "google"]
if client_id:
    types.append({"CFBundleURLName": "google", "CFBundleURLSchemes": [
        "com.googleusercontent.apps." + client_id.removesuffix(".apps.googleusercontent.com")
    ]})
info["CFBundleURLTypes"] = types
with path.open("wb") as f:
    plistlib.dump(info, f, sort_keys=False)
print("Prepared iOS callback schemes. No private credentials were written.")
