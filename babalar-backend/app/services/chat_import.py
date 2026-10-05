"""Import of WhatsApp "Export chat" (.txt / .zip) files.

Fallback for when live ingestion via whatsapp-web.js is unavailable. Messages go through the
same filter -> categorize -> embed -> insert path as /api/ingest/messages.
"""
import io
import re
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Message, WaGroup
from app.services.categorizer import categorize_batch
from app.services.embedding import embed_batch
from app.services.pii import first_name, scrub_text

MIN_CONTENT_LENGTH = 40  # same threshold as /api/ingest/messages
BATCH_SIZE = 100
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
DEFAULT_TZ = "Europe/Berlin"

# iOS:     [24.03.25, 14:32:10] Name: text      (12h clocks add AM/PM)
# Android: 24.03.2025, 14:32 - Name: text
_IOS_RE = re.compile(
    r"^\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp][Mm])?\]\s(.*)$"
)
_ANDROID_RE = re.compile(
    r"^(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp][Mm])?\s-\s(.*)$"
)
_INVISIBLE = dict.fromkeys(map(ord, "‎‏‪‫‬ ﻿"), None)
_SKIPPED_BODIES = (
    "<media omitted>", "<medya dahil edilmedi>", "<medien ausgeschlossen>",
    "image omitted", "video omitted", "sticker omitted", "audio omitted", "gif omitted",
    "this message was deleted", "bu mesaj silindi", "diese nachricht wurde gelöscht",
    "you deleted this message", "<this message was edited>",
)


class ChatImportError(ValueError):
    pass


@dataclass
class ParsedMessage:
    sent_at: datetime  # UTC
    sender_name: str | None
    content: str


@dataclass
class ParseResult:
    messages: list[ParsedMessage]
    total_lines: int
    skipped_system: int
    skipped_media: int


def decode_upload(data: bytes, filename: str) -> str:
    """Return chat text from a .txt or .zip export."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise ChatImportError("Dosya çok büyük (en fazla 25 MB).")
    if filename.lower().endswith(".zip") or data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                txt_names = [n for n in zf.namelist() if n.lower().endswith(".txt")]
                if not txt_names:
                    raise ChatImportError("Zip içinde .txt dosyası bulunamadı.")
                info = zf.getinfo(txt_names[0])
                if info.file_size > MAX_UPLOAD_BYTES * 4:
                    raise ChatImportError("Zip içindeki metin dosyası çok büyük.")
                data = zf.read(info)
        except zipfile.BadZipFile as e:
            raise ChatImportError("Geçersiz zip dosyası.") from e
    for encoding in ("utf-8-sig", "utf-16"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ChatImportError("Dosya UTF-8 olarak okunamadı.")


def _to_utc(day: str, month: str, year: str, hour: str, minute: str, second: str | None, ampm: str | None, tz: ZoneInfo) -> datetime:
    y = int(year)
    if y < 100:
        y += 2000
    h = int(hour)
    if ampm:
        h = h % 12 + (12 if ampm.lower() == "pm" else 0)
    local = datetime(y, int(month), int(day), h, int(minute), int(second or 0), tzinfo=tz)
    return local.astimezone(timezone.utc)


def parse_export(text: str, tz_name: str = DEFAULT_TZ) -> ParseResult:
    try:
        tz = ZoneInfo(tz_name)
    except Exception as e:
        raise ChatImportError(f"Geçersiz saat dilimi: {tz_name}") from e

    # (sent_at, sender, [lines]) — None sender means system line
    entries: list[tuple[datetime, str | None, list[str]]] = []
    total_lines = 0
    for raw in text.splitlines():
        line = raw.translate(_INVISIBLE)
        total_lines += 1
        match = _IOS_RE.match(line) or _ANDROID_RE.match(line)
        if match:
            *parts, rest = match.groups()
            try:
                sent_at = _to_utc(*parts, tz)
            except ValueError:
                # Impossible date: most likely month-first format or garbage; treat as continuation
                if entries:
                    entries[-1][2].append(line)
                continue
            sender, sep, body = rest.partition(": ")
            if sep:
                entries.append((sent_at, sender.strip(), [body]))
            else:
                entries.append((sent_at, None, [rest]))
        elif entries:
            entries[-1][2].append(line)

    if not entries:
        raise ChatImportError("Dosyada tanınan mesaj satırı yok. WhatsApp 'Sohbeti dışa aktar' (medyasız) dosyası mı?")

    messages: list[ParsedMessage] = []
    skipped_system = skipped_media = 0
    for sent_at, sender, lines in entries:
        if sender is None:
            skipped_system += 1
            continue
        content = "\n".join(lines).strip()
        if content.lower() in _SKIPPED_BODIES:
            skipped_media += 1
            continue
        messages.append(ParsedMessage(sent_at=sent_at, sender_name=sender, content=content))
    return ParseResult(messages=messages, total_lines=total_lines, skipped_system=skipped_system, skipped_media=skipped_media)


def _minute_key(sent_at: datetime, content: str) -> tuple[datetime, str]:
    # Export timestamps have minute (or second) precision, live-ingested ones are exact.
    return sent_at.astimezone(timezone.utc).replace(second=0, microsecond=0), content


async def plan_import(db: AsyncSession, group: WaGroup, parsed: ParseResult) -> list[ParsedMessage]:
    """Scrubbed messages that pass the length filter and are not already stored for the group."""
    candidates = [(m, scrub_text(m.content)) for m in parsed.messages]
    candidates = [(m, clean) for m, clean in candidates if len(clean) >= MIN_CONTENT_LENGTH]
    if not candidates:
        return []
    lo = min(m.sent_at for m, _ in candidates) - timedelta(minutes=1)
    hi = max(m.sent_at for m, _ in candidates) + timedelta(minutes=1)
    rows = await db.execute(
        select(Message.sent_at, Message.content).where(
            Message.group_id == group.id, Message.sent_at.between(lo, hi)
        )
    )
    seen = {_minute_key(r.sent_at, r.content.strip()) for r in rows}
    new: list[ParsedMessage] = []
    for m, clean in candidates:
        clean_key = _minute_key(m.sent_at, clean)
        raw_key = _minute_key(m.sent_at, m.content)  # rows stored before scrubbing hold raw text
        if clean_key in seen or raw_key in seen:
            continue
        seen.add(clean_key)
        new.append(ParsedMessage(sent_at=m.sent_at, sender_name=first_name(m.sender_name), content=clean))
    return new


async def run_import(db: AsyncSession, group_id: uuid.UUID, new_messages: list[ParsedMessage]) -> int:
    """Categorize, embed and insert in batches; commits per batch so a failure keeps earlier batches."""
    saved = 0
    for i in range(0, len(new_messages), BATCH_SIZE):
        batch = new_messages[i : i + BATCH_SIZE]
        contents = [m.content for m in batch]
        categories = await categorize_batch(contents)
        embeddings = await embed_batch(contents)
        for m, category, embedding in zip(batch, categories, embeddings):
            db.add(Message(
                group_id=group_id,
                sender_name=m.sender_name,
                content=m.content,
                sent_at=m.sent_at,
                category=category,
                embedding=embedding,
            ))
        await db.commit()
        saved += len(batch)
    return saved
