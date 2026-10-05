import secrets
import json
import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_admin_user
from app.database import get_db
from app.models.models import AdminConfig, DailyTotalUsage, InviteCode, Message, User, UserDailyUsage, WaGroup
from app.services.chat_import import DEFAULT_TZ, MAX_UPLOAD_BYTES, ChatImportError, decode_upload, parse_export, plan_import, run_import
from app.services.log_buffer import append_log
from app.services.history import PREFIX as HISTORY_PREFIX, history_key, queue_history, cancel_history

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/config")
async def get_config(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    rows = await db.execute(select(AdminConfig))
    return {row.key: row.value for row in rows.scalars() if not row.key.startswith(HISTORY_PREFIX)}


class ConfigUpdate(BaseModel):
    value: str


@router.put("/config/{key}")
async def update_config(key: str, req: ConfigUpdate, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    row = await db.get(AdminConfig, key)
    if not row:
        db.add(AdminConfig(key=key, value=req.value))
    else:
        row.value = req.value
    await db.commit()
    return {"key": key, "value": req.value}


@router.get("/invite-codes")
async def list_invite_codes(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    rows = await db.execute(select(InviteCode).order_by(InviteCode.created_at.desc()))
    codes = rows.scalars().all()
    return [{"id": str(c.id), "code": c.code, "max_uses": c.max_uses, "use_count": c.use_count, "is_active": c.is_active} for c in codes]


class InviteCodeCreate(BaseModel):
    max_uses: int = 10


@router.post("/invite-codes", status_code=201)
async def create_invite_code(req: InviteCodeCreate, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    code = InviteCode(code=secrets.token_urlsafe(8), max_uses=req.max_uses)
    db.add(code)
    await db.commit()
    return {"code": code.code, "max_uses": code.max_uses}


@router.delete("/invite-codes/{code_id}")
async def delete_invite_code(code_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    import uuid
    row = await db.get(InviteCode, uuid.UUID(code_id))
    if not row:
        raise HTTPException(status_code=404, detail="Code not found")
    row.is_active = False
    await db.commit()
    return {"message": "Deactivated"}


@router.get("/users")
async def list_users(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_admin_user)):
    rows = await db.execute(select(User).order_by(User.created_at.desc()))
    users = rows.scalars().all()

    today = date.today()
    usage_rows = await db.execute(
        select(UserDailyUsage).where(UserDailyUsage.usage_date == today)
    )
    today_usage = {str(r.user_id): r.count for r in usage_rows.scalars()}
    global_limit_row = await db.get(AdminConfig, "user_daily_limit")
    global_limit = int(global_limit_row.value) if global_limit_row else 5

    return [
        {
            "id": str(u.id),
            "email": u.email,
            "username": u.username,
            "role": u.role,
            "is_admin": u.is_admin,
            "is_active": u.is_active,
            "daily_limit_override": u.daily_limit_override,
            "daily_limit": u.daily_limit_override if u.daily_limit_override is not None else global_limit,
            "today_usage": today_usage.get(str(u.id), 0),
        }
        for u in users
    ]


class UserRoleUpdate(BaseModel):
    role: str


@router.put("/users/{user_id}/role")
async def update_user_role(
    user_id: str,
    req: UserRoleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    import uuid as _uuid
    if req.role not in ("member", "admin", "owner"):
        raise HTTPException(status_code=400, detail="Invalid role")

    target = await db.get(User, _uuid.UUID(user_id))
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if str(target.id) == str(current_user.id):
        raise HTTPException(status_code=400, detail="Cannot change your own role")

    # Only owner can touch owner-level (promote to owner or demote an owner)
    if req.role == "owner" or target.role == "owner":
        if current_user.role != "owner":
            raise HTTPException(status_code=403, detail="Owner permission required for this action")

    target.role = req.role
    await db.commit()
    return {"id": user_id, "role": target.role}


class UserLimitUpdate(BaseModel):
    daily_limit_override: int | None


@router.put("/users/{user_id}/limit")
async def update_user_limit(
    user_id: str,
    req: UserLimitUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    import uuid as _uuid
    target = await db.get(User, _uuid.UUID(user_id))
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    target.daily_limit_override = req.daily_limit_override
    await db.commit()
    return {"id": user_id, "daily_limit_override": target.daily_limit_override}


@router.get("/groups")
async def list_groups(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    rows = await db.execute(select(WaGroup).order_by(WaGroup.group_name))
    groups = rows.scalars().all()
    stats_rows = await db.execute(
        select(
            Message.group_id,
            func.count(Message.id).label("cnt"),
            func.min(Message.sent_at).label("oldest"),
            func.max(Message.sent_at).label("newest"),
        ).group_by(Message.group_id)
    )
    stats = {r.group_id: r for r in stats_rows}
    history_rows = (await db.execute(select(AdminConfig).where(AdminConfig.key.startswith(HISTORY_PREFIX)))).scalars().all()
    histories = {row.key: json.loads(row.value) for row in history_rows}
    active_status = await db.get(AdminConfig, "ingesting_group_wa_id")
    ingesting_wa_id = active_status.value if active_status else None
    force_run_row = await db.get(AdminConfig, "force_run")
    pending_wa_id = force_run_row.value if force_run_row else None
    force_run_group_ids_row = await db.get(AdminConfig, "force_run_group_ids")
    try:
        pending_wa_ids = set(json.loads(force_run_group_ids_row.value)) if force_run_group_ids_row else set()
    except Exception:
        pending_wa_ids = set()

    def is_pending(g: WaGroup) -> bool:
        if ingesting_wa_id == g.wa_group_id:
            return False  # already ingesting, not just pending
        if pending_wa_id == "all":
            return g.is_active
        return pending_wa_id == g.wa_group_id or g.wa_group_id in pending_wa_ids

    return [
        {
            "id": str(g.id),
            "wa_group_id": g.wa_group_id,
            "name": g.group_name,
            "is_active": g.is_active,
            "last_ingested_at": g.last_ingested_at,
            "message_count": stats[g.id].cnt if g.id in stats else 0,
            "oldest_message_at": stats[g.id].oldest if g.id in stats else None,
            "newest_message_at": stats[g.id].newest if g.id in stats else None,
            "is_ingesting": g.wa_group_id == ingesting_wa_id,
            "is_pending": is_pending(g),
            "history": histories.get(history_key(g.id)),
        }
        for g in groups
    ]


@router.put("/groups/{group_id}/toggle")
async def toggle_group(group_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    import uuid
    group = await db.get(WaGroup, uuid.UUID(group_id))
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    group.is_active = not group.is_active
    await db.commit()
    return {"id": str(group.id), "name": group.group_name, "is_active": group.is_active}


@router.post("/groups/fetch-all")
async def trigger_fetch_all(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    row = await db.get(AdminConfig, "force_run")
    if row:
        row.value = "all"
    else:
        db.add(AdminConfig(key="force_run", value="all"))
    await db.commit()
    return {"ok": True}


class FetchSelectedGroups(BaseModel):
    group_ids: list[str]


class HistoryPageRequest(BaseModel):
    page_size: int = 500
    recheck: bool = False


@router.post("/groups/{group_id}/history")
async def trigger_history(group_id: uuid.UUID, req: HistoryPageRequest, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    if req.page_size not in (250, 500, 1000):
        raise HTTPException(422, "Page size must be 250, 500 or 1000")
    return await queue_history(db, group_id, req.page_size, req.recheck)


@router.post("/groups/{group_id}/history/cancel")
async def cancel_history_request(group_id: uuid.UUID, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    return await cancel_history(db, group_id)


@router.post("/groups/fetch-selected")
async def trigger_fetch_selected(req: FetchSelectedGroups, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    import json
    import uuid

    ids = [uuid.UUID(gid) for gid in req.group_ids]
    rows = await db.execute(select(WaGroup).where(WaGroup.id.in_(ids)))
    groups = rows.scalars().all()
    for group in groups:
        group.is_active = True

    wa_group_ids = [group.wa_group_id for group in groups]
    row = await db.get(AdminConfig, "force_run_group_ids")
    if row:
        row.value = json.dumps(wa_group_ids)
    else:
        db.add(AdminConfig(key="force_run_group_ids", value=json.dumps(wa_group_ids)))
    await db.commit()
    return {"ok": True, "queued": len(wa_group_ids)}


@router.post("/groups/{group_id}/fetch")
async def trigger_fetch(group_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    import uuid
    group = await db.get(WaGroup, uuid.UUID(group_id))
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    group.is_active = True
    row = await db.get(AdminConfig, "force_run")
    if row:
        row.value = group.wa_group_id
    else:
        db.add(AdminConfig(key="force_run", value=group.wa_group_id))
    await db.commit()
    return {"ok": True}


@router.delete("/groups/{group_id}/messages")
async def delete_group_messages(group_id: str, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    import uuid
    group = await db.get(WaGroup, uuid.UUID(group_id))
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    history = await db.get(AdminConfig, history_key(group.id))
    if history and json.loads(history.value).get("status") in ("queued", "running"):
        raise HTTPException(409, "Geçmiş taraması bitmeden mesajlar silinemez.")
    await db.execute(delete(Message).where(Message.group_id == group.id))
    if history:
        await db.delete(history)
    group.last_ingested_at = None
    await db.commit()
    return {"ok": True}


@router.post("/groups/{group_id}/import")
async def import_chat_export(
    group_id: uuid.UUID,
    file: UploadFile = File(...),
    dry_run: bool = Form(True),
    timezone: str = Form(DEFAULT_TZ),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_admin_user),
):
    """Import a WhatsApp 'Export chat' file (.txt/.zip) into a group. dry_run only parses and reports."""
    group = await db.get(WaGroup, group_id)
    if not group:
        raise HTTPException(404, "Group not found")
    filename = file.filename or "export"
    label = f"[import] {group.group_name} / {filename}"
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        parsed = parse_export(decode_upload(data, filename), timezone)
    except ChatImportError as e:
        append_log("ERROR", f"{label}: {e}")
        raise HTTPException(422, str(e))

    new_messages = await plan_import(db, group, parsed)
    stamps = [m.sent_at for m in parsed.messages]
    report = {
        "dry_run": dry_run,
        "timezone": timezone,
        "parsed": len(parsed.messages),
        "skipped_system": parsed.skipped_system,
        "skipped_media": parsed.skipped_media,
        "eligible": sum(1 for m in parsed.messages if len(m.content) >= 40),
        "new": len(new_messages),
        "first_at": min(stamps).isoformat() if stamps else None,
        "last_at": max(stamps).isoformat() if stamps else None,
        "sample": [{"sent_at": m.sent_at.isoformat(), "sender": m.sender_name, "content": m.content[:120]} for m in new_messages[:5]],
    }
    if dry_run:
        append_log("INFO", f"{label}: preview parsed={report['parsed']} new={report['new']}")
        return report
    append_log("INFO", f"{label}: import started, {len(new_messages)} new messages")
    try:
        report["saved"] = await run_import(db, group.id, new_messages)
    except Exception as e:
        await db.rollback()
        append_log("ERROR", f"{label}: import failed: {type(e).__name__}: {e}")
        raise HTTPException(500, f"İçe aktarma başarısız: {type(e).__name__}: {e}")
    append_log("INFO", f"{label}: import finished, saved={report['saved']}")
    return report
    report["saved"] = await run_import(db, group.id, new_messages)
    return report


class BulkSetActive(BaseModel):
    group_ids: list[str]
    is_active: bool


@router.post("/groups/bulk-set-active")
async def bulk_set_active(req: BulkSetActive, db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    import uuid
    ids = [uuid.UUID(gid) for gid in req.group_ids]
    rows = await db.execute(select(WaGroup).where(WaGroup.id.in_(ids)))
    groups = rows.scalars().all()
    for g in groups:
        g.is_active = req.is_active
    await db.commit()
    return {"updated": len(groups), "is_active": req.is_active}


@router.get("/qr")
async def get_whatsapp_qr(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    row = await db.get(AdminConfig, "whatsapp_qr")
    return {"data_url": row.value if row else None}


@router.get("/whatsapp/status")
async def get_whatsapp_status(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    qr = await db.get(AdminConfig, "whatsapp_qr")
    if qr:
        return {"status": "waiting_qr"}
    status = await db.get(AdminConfig, "whatsapp_status")
    return {"status": status.value if status else "unknown"}


@router.post("/whatsapp/reconnect")
async def request_whatsapp_reconnect(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    row = await db.get(AdminConfig, "whatsapp_reconnect")
    if row:
        row.value = "1"
    else:
        db.add(AdminConfig(key="whatsapp_reconnect", value="1"))
    # Clear stale QR if any
    qr_row = await db.get(AdminConfig, "whatsapp_qr")
    if qr_row:
        await db.delete(qr_row)
    await db.commit()
    return {"ok": True}


@router.get("/stats")
async def stats(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    total_messages = await db.scalar(select(func.count(Message.id)))
    total_users = await db.scalar(select(func.count(User.id)))
    total_questions = await db.scalar(select(func.sum(DailyTotalUsage.count))) or 0
    today_usage = await db.scalar(
        select(DailyTotalUsage.count).where(DailyTotalUsage.usage_date == date.today())
    )
    active_groups = await db.scalar(select(func.count(WaGroup.id)).where(WaGroup.is_active == True))
    return {
        "total_messages": total_messages,
        "total_users": total_users,
        "today_questions": today_usage or 0,
        "total_questions": total_questions,
        "active_groups": active_groups,
    }


@router.get("/stats/daily")
async def daily_stats(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    since = date.today() - timedelta(days=29)
    rows = await db.execute(
        select(DailyTotalUsage)
        .where(DailyTotalUsage.usage_date >= since)
        .order_by(DailyTotalUsage.usage_date)
    )
    data = {r.usage_date: r.count for r in rows.scalars()}
    result = []
    for i in range(30):
        d = since + timedelta(days=i)
        result.append({"date": str(d), "count": data.get(d, 0)})
    return result


@router.get("/stats/users")
async def user_stats(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    rows = await db.execute(
        select(User.username, User.email, func.sum(UserDailyUsage.count).label("total"))
        .join(UserDailyUsage, User.id == UserDailyUsage.user_id)
        .group_by(User.id, User.username, User.email)
        .order_by(func.sum(UserDailyUsage.count).desc())
        .limit(20)
    )
    return [{"username": r.username, "email": r.email, "total": int(r.total)} for r in rows]


@router.get("/logs")
async def get_ingestion_logs(_: User = Depends(get_admin_user)):
    from app.services.log_buffer import get_logs
    return get_logs()


@router.post("/ingestion/reset-status")
async def reset_ingestion_status(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    row = await db.get(AdminConfig, "ingesting_group_wa_id")
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}


@router.post("/ingestion/cancel")
async def cancel_ingestion(db: AsyncSession = Depends(get_db), _: User = Depends(get_admin_user)):
    row = await db.get(AdminConfig, "cancel_requested")
    if not row:
        db.add(AdminConfig(key="cancel_requested", value="1"))
    await db.commit()
    return {"ok": True}
