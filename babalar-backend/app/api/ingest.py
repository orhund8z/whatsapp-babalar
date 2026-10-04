from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.models import AdminConfig, Message, WaGroup
from app.services.categorizer import categorize_batch
from app.services.embedding import embed_batch

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


def verify_ingest_key(x_ingest_key: str = Header(...)):
    if x_ingest_key != settings.ingest_api_key:
        raise HTTPException(status_code=401, detail="Invalid ingest API key")


class RawMessage(BaseModel):
    sender_name: str | None
    content: str
    sent_at: datetime


class GroupIngestRequest(BaseModel):
    wa_group_id: str
    group_name: str
    messages: list[RawMessage]


@router.post("/messages")
async def ingest_messages(
    req: GroupIngestRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_ingest_key),
):
    # Upsert the group
    result = await db.execute(select(WaGroup).where(WaGroup.wa_group_id == req.wa_group_id))
    group = result.scalar_one_or_none()
    if not group:
        group = WaGroup(wa_group_id=req.wa_group_id, group_name=req.group_name)
        db.add(group)
        await db.flush()

    candidates = [(raw.sent_at, raw.content.strip()) for raw in req.messages if len(raw.content.strip()) >= 40]
    if not candidates:
        return {"saved": 0, "group": req.group_name}

    # Deduplicate: find which (sent_at, content) pairs already exist for this group
    existing_rows = await db.execute(
        select(Message.sent_at, Message.content).where(
            Message.group_id == group.id,
            tuple_(Message.sent_at, Message.content).in_(candidates),
        )
    )
    existing = {(row.sent_at, row.content) for row in existing_rows}

    sender_map = {(r.sent_at, r.content.strip()): r.sender_name for r in req.messages}
    new_items = [(sent_at, content) for sent_at, content in candidates if (sent_at, content) not in existing]

    saved = 0
    if new_items:
        contents = [content for _, content in new_items]
        categories = await categorize_batch(contents)
        embeddings = await embed_batch(contents)

        for (sent_at, content), category, embedding in zip(new_items, categories, embeddings):
            db.add(Message(
                group_id=group.id,
                sender_name=sender_map.get((sent_at, content)),
                content=content,
                sent_at=sent_at,
                category=category,
                embedding=embedding,
            ))
            saved += 1

    await db.commit()
    return {"saved": saved, "group": req.group_name}


class DiscoverRequest(BaseModel):
    wa_group_id: str
    group_name: str


class MarkCheckedRequest(BaseModel):
    wa_group_id: str
    group_name: str
    checked_at: datetime | None = None


@router.post("/mark-checked")
async def mark_checked(
    req: MarkCheckedRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_ingest_key),
):
    result = await db.execute(select(WaGroup).where(WaGroup.wa_group_id == req.wa_group_id))
    group = result.scalar_one_or_none()
    if group:
        group.last_ingested_at = req.checked_at or datetime.now(timezone.utc)
        await db.commit()
    return {"ok": True}


@router.post("/discover")
async def discover_group(
    req: DiscoverRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(verify_ingest_key),
):
    result = await db.execute(select(WaGroup).where(WaGroup.wa_group_id == req.wa_group_id))
    group = result.scalar_one_or_none()
    if not group:
        group = WaGroup(wa_group_id=req.wa_group_id, group_name=req.group_name, is_active=False)
        db.add(group)
    else:
        group.group_name = req.group_name  # name may have changed
    await db.commit()
    return {"wa_group_id": group.wa_group_id, "is_active": group.is_active}


@router.get("/config")
async def get_ingest_config(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "ingestion_lookback_days")
    return {"ingestion_lookback_days": int(row.value) if row else 30}


@router.get("/trigger")
async def check_trigger(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    pending = await db.execute(
        select(WaGroup).where(WaGroup.is_active == True, WaGroup.last_ingested_at == None).limit(1)
    )
    if pending.scalar_one_or_none() is not None:
        return {"should_run": True, "group_id": None}
    force = await db.get(AdminConfig, "force_run")
    if force:
        # Don't delete here — let the scheduler clear it at the start of the actual run.
        # "all" means fetch all active groups (same as cron), specific wa_group_id means per-group.
        group_id = None if force.value == "all" else force.value
        return {"should_run": True, "group_id": group_id}
    return {"should_run": False, "group_id": None}


class LogEntry(BaseModel):
    level: str  # INFO | WARN | ERROR
    message: str


@router.post("/log")
async def post_log(entry: LogEntry, _: None = Depends(verify_ingest_key)):
    from app.services.log_buffer import append_log
    append_log(entry.level, entry.message)
    return {"ok": True}


@router.get("/cancel-requested")
async def check_cancel(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "cancel_requested")
    if row:
        await db.delete(row)
        await db.commit()
        return {"cancel": True}
    return {"cancel": False}


@router.post("/clear-force-run")
async def clear_force_run(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    force = await db.get(AdminConfig, "force_run")
    if force:
        await db.delete(force)
        await db.commit()
    return {"ok": True}


class QRRequest(BaseModel):
    data_url: str


@router.post("/set-qr")
async def set_qr(req: QRRequest, db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "whatsapp_qr")
    if row:
        row.value = req.data_url
    else:
        db.add(AdminConfig(key="whatsapp_qr", value=req.data_url))
    status = await db.get(AdminConfig, "whatsapp_status")
    if status:
        status.value = "waiting_qr"
    else:
        db.add(AdminConfig(key="whatsapp_status", value="waiting_qr"))
    await db.commit()
    return {"ok": True}


@router.post("/clear-qr")
async def clear_qr(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "whatsapp_qr")
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}


@router.get("/qr")
async def get_qr(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "whatsapp_qr")
    return {"data_url": row.value if row else None}


@router.get("/reconnect-requested")
async def check_reconnect(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "whatsapp_reconnect")
    if row:
        await db.delete(row)
        await db.commit()
        return {"reconnect": True}
    return {"reconnect": False}


class WhatsAppStatusUpdate(BaseModel):
    status: str  # "connected" | "disconnected" | "auth_failure"


@router.post("/whatsapp-status")
async def update_whatsapp_status(req: WhatsAppStatusUpdate, db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "whatsapp_status")
    if row:
        row.value = req.status
    else:
        db.add(AdminConfig(key="whatsapp_status", value=req.status))
    if req.status != "waiting_qr":
        qr = await db.get(AdminConfig, "whatsapp_qr")
        if qr:
            await db.delete(qr)
    await db.commit()
    return {"ok": True}


class StatusRequest(BaseModel):
    wa_group_id: str | None  # None = clear (ingestion idle)


@router.post("/set-status")
async def set_status(req: StatusRequest, db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    row = await db.get(AdminConfig, "ingesting_group_wa_id")
    if req.wa_group_id is None:
        if row:
            await db.delete(row)
    else:
        if row:
            row.value = req.wa_group_id
        else:
            db.add(AdminConfig(key="ingesting_group_wa_id", value=req.wa_group_id))
    await db.commit()
    return {"ok": True}


@router.get("/groups")
async def get_groups(db: AsyncSession = Depends(get_db), _: None = Depends(verify_ingest_key)):
    rows = await db.execute(select(WaGroup).where(WaGroup.is_active == True))
    groups = rows.scalars().all()
    return [
        {"wa_group_id": g.wa_group_id, "group_name": g.group_name, "last_ingested_at": g.last_ingested_at}
        for g in groups
    ]
