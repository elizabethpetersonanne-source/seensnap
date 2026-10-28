"""Oct-27 followup A72 + PRIV02-03: user-submitted bug reports.

Attachments are stored OUTSIDE the public `/uploads` and `/media`
static mounts and served through an authenticated download endpoint.
Only the report owner or an explicitly authorized support role can
read a file.
"""
from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.core.config import settings
from app.models.social import BugReport


router = APIRouter()


_ALLOWED_IMAGE_TYPES: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
}
# PRIV03: image magic bytes. We validate CONTENT, not just the MIME
# header a client sends — a text/html claim doesn't matter if the
# first bytes are JPEG. Unknown-magic files are rejected.
_IMAGE_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"RIFF", "image/webp"),  # followed by WEBP later
    (b"ftypheic", "image/heic"),  # offset 4; we check contains
    (b"ftypheix", "image/heic"),
    (b"ftypmif1", "image/heic"),
    (b"ftypmsf1", "image/heic"),
)
_MAX_FILE_BYTES = 6 * 1024 * 1024  # 6 MB per file
_MAX_FILES = 3


def _sniff_image_type(head: bytes) -> str | None:
    """Return canonical MIME type based on magic bytes, or None if
    the content is not a recognised allowed image."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    # HEIC/HEIF: ftyp box lives at bytes 4..12.
    if head[4:12] in {b"ftypheic", b"ftypheix", b"ftypmif1", b"ftypmsf1"}:
        return "image/heic"
    return None


class BugReportResponse(BaseModel):
    id: str
    description: str
    status: str
    attachment_urls: list[str]
    created_at: str


@router.post("", response_model=BugReportResponse, status_code=status.HTTP_201_CREATED)
def submit_bug_report(
    request: Request,
    current_user: CurrentUser,
    db: DbSession,
    description: str = Form(..., min_length=1, max_length=5000),
    diagnostics: str | None = Form(default=None),
    files: list[UploadFile] = File(default_factory=list),
) -> BugReportResponse:
    text = description.strip()
    if not text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Description cannot be empty.",
        )

    parsed_diagnostics: dict | None = None
    if diagnostics:
        try:
            parsed_diagnostics = json.loads(diagnostics)
            if not isinstance(parsed_diagnostics, dict):
                parsed_diagnostics = None
        except json.JSONDecodeError:
            parsed_diagnostics = None

    attachments = [f for f in (files or []) if f is not None]
    if len(attachments) > _MAX_FILES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"At most {_MAX_FILES} attachments.",
        )

    report_id = uuid4()
    saved_filenames: list[str] = []
    bug_dir: Path | None = None
    base = str(request.base_url).rstrip("/")
    attachment_urls: list[str] = []

    try:
        if attachments:
            # PRIV02: write to the PRIVATE directory, not /uploads.
            bug_dir = settings.private_uploads_path() / "bug-reports" / str(report_id)
            bug_dir.mkdir(parents=True, exist_ok=True)
            total_bytes = 0
            for idx, f in enumerate(attachments):
                # PRIV03: bounded read — don't slurp a huge file into
                # memory before the size check. Read in 128KB chunks
                # and stop at the cap + 1 to raise.
                chunks: list[bytes] = []
                read_cap = _MAX_FILE_BYTES + 1
                read_so_far = 0
                while read_so_far < read_cap:
                    chunk = f.file.read(min(128 * 1024, read_cap - read_so_far))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    read_so_far += len(chunk)
                if read_so_far > _MAX_FILE_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="Attachment exceeds 6 MB.",
                    )
                data = b"".join(chunks)
                if not data:
                    continue
                total_bytes += len(data)
                if total_bytes > _MAX_FILES * _MAX_FILE_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="Combined attachments exceed limit.",
                    )
                # PRIV03: sniff the actual bytes rather than trust the
                # client-sent MIME header.
                sniffed = _sniff_image_type(data[:16])
                if sniffed is None:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Attachment content isn't a supported image.",
                    )
                ext = _ALLOWED_IMAGE_TYPES[sniffed]
                # Server-generated filename — never trust client input.
                filename = f"attachment_{idx}{ext}"
                (bug_dir / filename).write_bytes(data)
                saved_filenames.append(filename)
                attachment_urls.append(
                    f"{base}{settings.api_v1_prefix}/me/bug-reports/{report_id}/attachments/{filename}"
                )

        row = BugReport(
            id=report_id,
            user_id=current_user.id,
            description=text,
            diagnostics=parsed_diagnostics,
            attachment_urls=attachment_urls,
            status="open",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return BugReportResponse(
            id=str(row.id),
            description=row.description,
            status=row.status,
            attachment_urls=list(row.attachment_urls or []),
            created_at=row.created_at.isoformat(),
        )
    except HTTPException:
        # PRIV03: clean up partial files on failure before re-raising
        # so a 413 doesn't leave orphans on disk.
        if bug_dir is not None:
            for name in saved_filenames:
                try:
                    (bug_dir / name).unlink(missing_ok=True)
                except Exception:
                    pass
            try:
                bug_dir.rmdir()
            except Exception:
                pass
        raise


@router.get("", response_model=list[BugReportResponse])
def list_my_bug_reports(
    current_user: CurrentUser,
    db: DbSession,
) -> list[BugReportResponse]:
    rows = db.scalars(
        select(BugReport)
        .where(BugReport.user_id == current_user.id)
        .order_by(BugReport.created_at.desc())
        .limit(50)
    ).all()
    return [
        BugReportResponse(
            id=str(r.id),
            description=r.description,
            status=r.status,
            attachment_urls=list(r.attachment_urls or []),
            created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]


_SAFE_FILENAME = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


@router.get("/{report_id}/attachments/{filename}")
def download_bug_report_attachment(
    report_id: UUID,
    filename: str,
    current_user: CurrentUser,
    db: DbSession,
) -> FileResponse:
    """PRIV02: authenticated download of a bug-report attachment.
    Only the report owner can read; a random id is NOT authorization."""
    report = db.scalar(
        select(BugReport).where(
            BugReport.id == report_id,
            BugReport.user_id == current_user.id,
        )
    )
    if report is None:
        # 404 on both "not found" and "not owned" so we don't leak
        # existence to unauthorized viewers.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")

    # Reject path traversal / unexpected extensions.
    stem = Path(filename).name  # strips any path components
    if stem != filename or not any(stem.lower().endswith(ext) for ext in _SAFE_FILENAME):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid filename")

    path = settings.private_uploads_path() / "bug-reports" / str(report_id) / stem
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    return FileResponse(path)
