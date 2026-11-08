"""Validate, orient and strip metadata before storing small beta images durably."""

from io import BytesIO
from uuid import UUID
from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from app.models.team_state import MediaAsset
from app.core.config import settings

MAX_INPUT = 6 * 1024 * 1024
MAX_STORED = 512 * 1024


def sanitized_image(file, *, size=768):
    raw = file.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise HTTPException(413, detail="Image must be smaller than 6 MB.")
    try:
        with Image.open(BytesIO(raw)) as original:
            if original.format not in {"JPEG", "PNG", "WEBP", "HEIF", "AVIF"}:
                raise ValueError("format")
            if original.width * original.height > 32_000_000:
                raise ValueError("dimensions")
            original.load()
            oriented = ImageOps.exif_transpose(original).convert("RGB")
            oriented.thumbnail((size, size))
            # New pixel buffer discards EXIF, GPS, XMP and other ancillary data.
            clean = Image.new("RGB", oriented.size)
            clean.paste(oriented)
            output = BytesIO()
            clean.save(output, format="WEBP", quality=82, method=4)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise HTTPException(
            400,
            detail="Choose a valid JPEG, PNG or WebP image. Export HEIC photos as JPEG if needed.",
        )
    data = output.getvalue()
    if len(data) > MAX_STORED:
        raise HTTPException(413, detail="Please choose a smaller image.")
    return data


def store_image(db, owner_id, file, purpose, team_id=None):
    asset = MediaAsset(
        owner_user_id=owner_id,
        team_id=team_id,
        purpose=purpose,
        data=sanitized_image(file, size=1400 if purpose == "bug" else 768),
    )
    db.add(asset)
    db.flush()
    return f"{settings.api_v1_prefix}/media-assets/{asset.id}"


def remove_owned_asset(db, url, owner_id=None, team_id=None):
    if not url or "/media-assets/" not in url:
        return
    try:
        asset_id = UUID(url.rsplit("/", 1)[-1])
    except ValueError:
        return
    asset = db.get(MediaAsset, asset_id)
    if asset and (
        (owner_id and asset.owner_user_id == owner_id) or (team_id and asset.team_id == team_id)
    ):
        db.delete(asset)
