from uuid import UUID
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from app.api.dependencies import CurrentUser, DbSession
from app.models.content import ContentTitle
from app.schemas.scenedna import TitleCompatibility
from app.services.title_compatibility import scorer_for_user

router = APIRouter()


class TitleIds(BaseModel):
    title_ids: list[UUID] = Field(max_length=100)


@router.get("/{title_id}", response_model=TitleCompatibility)
def get_compatibility(title_id: UUID, current_user: CurrentUser, db: DbSession):
    title = db.get(ContentTitle, title_id)
    if title is None:
        raise HTTPException(404, detail="Title not found")
    return scorer_for_user(db, current_user.id, [title]).score(title)


@router.post("", response_model=dict[UUID, TitleCompatibility])
def get_compatibilities(payload: TitleIds, current_user: CurrentUser, db: DbSession):
    titles = db.scalars(select(ContentTitle).where(ContentTitle.id.in_(payload.title_ids))).all()
    scorer = scorer_for_user(db, current_user.id, titles)
    return {title.id: scorer.score(title) for title in titles}
