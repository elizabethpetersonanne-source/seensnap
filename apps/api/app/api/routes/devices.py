from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.models.social import NotificationOutbox
from app.models.user import Device
from app.schemas.notification import DeviceRegisterRequest, DeviceResponse

router = APIRouter()


@router.post("", response_model=DeviceResponse, status_code=status.HTTP_200_OK)
def register_device(payload: DeviceRegisterRequest, current_user: CurrentUser, db: DbSession) -> DeviceResponse:
    """Upsert a device push token for the authenticated user."""
    token = payload.expo_push_token.strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="expo_push_token is required")

    # Idempotent: find existing active device with this token for this user
    device = db.scalar(
        select(Device).where(
            Device.user_id == current_user.id,
            Device.expo_push_token == token,
        )
    )

    if device is None:
        # Also check if another user had this token — deactivate it
        stale = db.scalar(
            select(Device).where(
                Device.expo_push_token == token,
                Device.user_id != current_user.id,
            )
        )
        if stale is not None:
            stale.expo_push_token = None
            stale.enabled = False

        device = Device(
            user_id=current_user.id,
            platform=payload.platform,
            expo_push_token=token,
            app_env=payload.app_env,
            app_build=payload.app_build,
            permission_state=payload.permission_state,
            enabled=True,
            last_seen_at=datetime.now(UTC),
        )
        db.add(device)
    else:
        device.enabled = True
        device.app_env = payload.app_env
        device.app_build = payload.app_build
        device.permission_state = payload.permission_state
        device.last_seen_at = datetime.now(UTC)

    db.commit()
    db.refresh(device)
    return DeviceResponse(
        id=device.id,
        platform=device.platform,
        app_env=device.app_env,
        enabled=device.enabled,
        created_at=device.created_at,
    )


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def deregister_device(device_id: UUID, current_user: CurrentUser, db: DbSession) -> Response:
    """Disable and deregister a device push token."""
    device = db.scalar(
        select(Device).where(Device.id == device_id, Device.user_id == current_user.id)
    )
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    device.enabled = False
    device.expo_push_token = None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/deactivate-token", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_current_device_token(current_user: CurrentUser, db: DbSession, expo_push_token: str) -> Response:
    """Deactivate a specific push token on sign-out (token passed as query param)."""
    devices = db.scalars(
        select(Device).where(
            Device.user_id == current_user.id,
            Device.expo_push_token == expo_push_token,
        )
    ).all()
    for device in devices:
        device.enabled = False
        device.expo_push_token = None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
