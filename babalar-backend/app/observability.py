"""Initialize the shared SDK before integrations create their default client."""
import json
import os
import re

from app.config import settings
from langfuse import Langfuse
from langfuse.types import MaskOtelSpansResult, OtelSpanPatch

_EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")
_PHONE = re.compile(r"(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)")
_WA_ID = re.compile(r"\b\d+@(?:lid|c\.us|g\.us)\b")
_SENDER = re.compile(r"(\[\d{2}:\d{2}\s*\|\s*)[^\]\n]+(\])")


def redact(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if key in {"sender", "sender_name", "author"} else redact(item)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = _WA_ID.sub("[WHATSAPP_ID]", value)
        value = _EMAIL.sub("[EMAIL]", value)
        value = _PHONE.sub(lambda m: "[PHONE]" if len(re.sub(r"\D", "", m[0])) >= 9 else m[0], value)
        return _SENDER.sub(r"\1Anonim\2", value)
    return value


def mask_otel_spans(*, params):
    patches = {}
    for identifier, span in params.spans.items():
        replacements = {}
        for key, value in span.attributes.items():
            if isinstance(value, str):
                try:
                    parsed = json.loads(value) if value.startswith(("{", "[")) else None
                except (ValueError, TypeError):
                    parsed = None
                masked = json.dumps(redact(parsed), ensure_ascii=False) if parsed is not None else redact(value)
            elif isinstance(value, (list, tuple)):
                masked = redact(value)
            else:
                continue
            if masked != value:
                replacements[key] = masked
        if replacements:
            patches[identifier] = OtelSpanPatch(set_attributes=replacements)
    return MaskOtelSpansResult(span_patches=patches)


langfuse = Langfuse(
    public_key=settings.langfuse_public_key,
    secret_key=settings.langfuse_secret_key,
    base_url=settings.langfuse_base_url,
    tracing_enabled=settings.langfuse_enabled and os.getenv("LANGFUSE_TRACING_ENABLED", "true").lower() != "false",
    environment=settings.environment,
    release=os.getenv("APP_VERSION", "dev"),
    mask_otel_spans=mask_otel_spans,
)
