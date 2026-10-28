"""Oct-27 followup A72: user-submitted bug reports with real
attachment uploads.

Prior SET-04 implementation only wrote `screenshot_count` to the
analytics event stream; the actual files were never uploaded. This
endpoint accepts multipart/form-data with:
  - description (required)
  - diagnostics (optional JSON string: platform, OS, app build, …)
  - up to 3 image attachments (optional, image/* types only)

Attachments are written to <uploads>/bug-reports/<report_id>/ and
their URLs are stored on the BugReport row for triage.
"""
from __future__ import annotations

import json
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
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
_MAX_FILE_BYTES = 6 * 1024 * 1024  # 6 MB per file
_MAX_FILES = 3


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

    # Enforce the per-report cap BEFORE writing anything so a bad
    # client can't fill disk with 100 attachments.
    attachments = [f for f in (files or []) if f is not None]
    if len(attachments) > _MAX_FILES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"At most {_MAX_FILES} attachments.",
        )

    report_id = uuid4()
    saved_urls: list[str] = []

    if attachments:
        bug_dir = settings.uploads_path() / "bug-reports" / str(report_id)
        bug_dir.mkdir(parents=True, exist_ok=True)
        base = str(request.base_url).rstrip("/")
        for idx, f in enumerate(attachments):
            ctype = (f.content_type or "").lower()
            ext = _ALLOWED_IMAGE_TYPES.get(ctype)
            if ext is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unsupported attachment type: {ctype or 'unknown'}",
                )
            data = f.file.read()
            if not data:
                continue
            if len(data) > _MAX_FILE_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="Attachment exceeds 6 MB.",
                )
            filename = f"attachment_{idx}{ext}"
            (bug_dir / filename).write_bytes(data)
            saved_urls.append(f"{base}/uploads/bug-reports/{report_id}/{filename}")

    row = BugReport(
        id=report_id,
        user_id=current_user.id,
        description=text,
        diagnostics=parsed_diagnostics,
        attachment_urls=saved_urls,
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


@router.get("", response_model=list[BugReportResponse])
def list_my_bug_reports(
    current_user: CurrentUser,
    db: DbSession,
) -> list[BugReportResponse]:
    """Owner can see their own submitted reports (receipts). Admin
    triage endpoints are a separate concern."""
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
