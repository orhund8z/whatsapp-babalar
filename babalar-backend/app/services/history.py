import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, select

from app.models.models import AdminConfig, Message, WaGroup

PREFIX = "group_history:"


def history_key(group_id):
    return f"{PREFIX}{group_id}"


async def queue_history(db, group_id, page_size, recheck=False):
    group = (await db.execute(select(WaGroup).where(WaGroup.id == group_id).with_for_update())).scalar_one_or_none()
    if group is None:
        raise HTTPException(404, "Group not found")
    row = await db.get(AdminConfig, history_key(group_id))
    state = json.loads(row.value) if row else {}
    if state.get("status") in ("queued", "running"):
        raise HTTPException(409, "Bu grubun geçmiş taraması zaten sırada veya çalışıyor.")
    if state.get("exhausted") and not recheck:
        raise HTTPException(409, "WhatsApp bu grup için daha eski mesaj sunmadı.")
    if not state.get("before_at"):
        oldest = await db.scalar(select(func.min(Message.sent_at)).where(Message.group_id == group.id))
        config = await db.get(AdminConfig, "ingestion_lookback_days")
        days = int(config.value) if config else 30
        boundary = oldest or datetime.now(timezone.utc) - timedelta(days=days)
        if boundary.tzinfo is None:
            boundary = boundary.replace(tzinfo=timezone.utc)
        state["before_at"] = boundary.isoformat()
        state["before_id"] = None
    state.update(status="queued", request_id=str(uuid.uuid4()), page_size=page_size,
                 wa_group_id=group.wa_group_id, group_name=group.group_name,
                 error=None, exhausted=False, queued_at=datetime.now(timezone.utc).isoformat())
    if row:
        row.value = json.dumps(state)
    else:
        db.add(AdminConfig(key=history_key(group_id), value=json.dumps(state)))
    await db.commit()
    return state


async def claim_history(db):
    rows = (await db.execute(select(AdminConfig).where(AdminConfig.key.startswith(PREFIX))
                            .order_by(AdminConfig.updated_at).with_for_update(skip_locked=True))).scalars().all()
    for row in rows:
        state = json.loads(row.value)
        if state.get("status") != "queued":
            continue
        state.update(status="running", started_at=datetime.now(timezone.utc).isoformat())
        row.value = json.dumps(state)
        await db.commit()
        return {"key": row.key, **state}
    return None


async def finish_history(db, key, result):
    row = (await db.execute(select(AdminConfig).where(AdminConfig.key == key).with_for_update())).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "History request not found")
    state = json.loads(row.value)
    if state.get("request_id") != result.request_id or state.get("status") != "running":
        raise HTTPException(409, "History request is no longer running")
    if result.error:
        state.update(status="error", error=result.error[:2000],
                     saved=state.get("saved", 0) + result.saved)
    else:
        if result.before_at is not None:
            next_cursor = datetime.fromisoformat(result.before_at.replace("Z", "+00:00"))
            previous = datetime.fromisoformat(state["before_at"].replace("Z", "+00:00"))
            if next_cursor.tzinfo is None or next_cursor > previous:
                raise HTTPException(422, "History cursor must move backwards")
            if next_cursor == previous and state.get("before_id") and (result.before_id or "") >= state["before_id"]:
                raise HTTPException(422, "History cursor must move backwards")
            state.update(before_at=result.before_at, before_id=result.before_id)
        state.update(status="exhausted" if result.exhausted else "idle", exhausted=result.exhausted,
                     error=None, last_scanned=result.scanned, last_saved=result.saved,
                     scanned=state.get("scanned", 0) + result.scanned,
                     saved=state.get("saved", 0) + result.saved,
                     pages=state.get("pages", 0) + (1 if result.scanned else 0))
    state["finished_at"] = datetime.now(timezone.utc).isoformat()
    row.value = json.dumps(state)
    await db.commit()
    return state


async def recover_history(db):
    rows = (await db.execute(select(AdminConfig).where(AdminConfig.key.startswith(PREFIX)).with_for_update())).scalars().all()
    for row in rows:
        state = json.loads(row.value)
        if state.get("status") == "running":
            state.update(status="error", error="Tarama servis yeniden başlatıldığı için kesildi. Aynı sayfa tekrar denenebilir.")
            row.value = json.dumps(state)
    await db.commit()


async def cancel_history(db, group_id):
    row = (await db.execute(select(AdminConfig).where(AdminConfig.key == history_key(group_id)).with_for_update())).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "History request not found")
    state = json.loads(row.value)
    if state.get("status") == "queued":
        state.update(status="idle", request_id=str(uuid.uuid4()))
        row.value = json.dumps(state)
    elif state.get("status") == "running":
        cancel = await db.get(AdminConfig, "cancel_requested")
        if cancel:
            cancel.value = "1"
        else:
            db.add(AdminConfig(key="cancel_requested", value="1"))
    await db.commit()
    return state
