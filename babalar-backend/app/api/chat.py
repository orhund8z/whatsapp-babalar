from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Literal
import asyncio
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.models.models import Message, User, UserDailyUsage
from app.services import rate_limiter, rag
from app.config import settings
from app.observability import langfuse
from app.services.feedback import feedback_token, verify_feedback, feedback_score_id

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.get("/usage")
async def get_usage(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.is_admin:
        return {"used": 0, "limit": None, "is_admin": True}
    today = date.today()
    if current_user.daily_limit_override is not None:
        user_limit = current_user.daily_limit_override
    else:
        user_limit = await rate_limiter._get_config(db, "user_daily_limit", 5)
    used = await db.scalar(
        select(UserDailyUsage.count).where(
            UserDailyUsage.user_id == current_user.id,
            UserDailyUsage.usage_date == today,
        )
    ) or 0
    return {"used": used, "limit": user_limit, "is_admin": False}


class HistoryMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str


class AskRequest(BaseModel):
    question: str
    history: list[HistoryMessage] = []


@router.post("/ask")
async def ask(
    req: AskRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    if not current_user.is_admin:
        allowed, reason = await rate_limiter.check_and_increment(db, current_user.id, current_user.daily_limit_override)
        if not allowed:
            raise HTTPException(status_code=429, detail=reason)

    result = await rag.answer(db, req.question, [h.model_dump() for h in req.history], user_id=str(current_user.id))
    if result.get("trace_id"):
        result["feedback_token"] = feedback_token(result["trace_id"], str(current_user.id))
    return result


class FeedbackRequest(BaseModel):
    trace_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    feedback_token: str = Field(max_length=1024)
    value: Literal[0, 1]


@router.post("/feedback")
async def submit_feedback(req: FeedbackRequest, current_user: User = Depends(get_current_user)):
    if not settings.langfuse_enabled:
        raise HTTPException(503, "Feedback is unavailable without Langfuse credentials")
    user_id = str(current_user.id)
    if not verify_feedback(req.feedback_token, req.trace_id, user_id):
        raise HTTPException(403, "Feedback token is invalid or expired")
    langfuse.create_score(name="user-thumbs", value=float(req.value), data_type="BOOLEAN",
                          trace_id=req.trace_id, score_id=feedback_score_id(req.trace_id, user_id))
    await asyncio.to_thread(langfuse.flush)
    return {"ok": True, "value": req.value}


@router.get("/categories")
async def categories(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    rows = await db.execute(
        select(Message.category, func.count(Message.id).label("count"))
        .where(Message.category.isnot(None))
        .group_by(Message.category)
        .order_by(func.count(Message.id).desc())
    )
    return [{"category": row.category, "count": row.count} for row in rows]


class SearchRequest(BaseModel):
    query: str
    category: str | None = None
    limit: int = 20


@router.post("/search")
async def search(
    req: SearchRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    where_clause = "AND m.category = :cat" if req.category else ""
    rows = await db.execute(
        text(f"""
            SELECT m.content, m.sender_name, m.sent_at, m.category, g.group_name,
                   1 - (m.embedding <=> (
                       SELECT embedding FROM messages
                       WHERE content ILIKE :q LIMIT 1
                   )) AS similarity
            FROM messages m
            JOIN wa_groups g ON g.id = m.group_id
            WHERE m.content ILIKE :q {where_clause}
            ORDER BY m.sent_at DESC
            LIMIT :limit
        """),
        {"q": f"%{req.query}%", "cat": req.category, "limit": req.limit},
    )
    results = rows.fetchall()
    return [
        {
            "content": r.content,
            "sender": r.sender_name,
            "date": r.sent_at.strftime("%d.%m.%Y"),
            "group": r.group_name,
            "category": r.category,
        }
        for r in results
    ]
