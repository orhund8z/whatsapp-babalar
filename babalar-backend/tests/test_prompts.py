from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.config import settings
from app.observability import langfuse
from app.prompts import system_prompt
from app.services import rag


@pytest.fixture
def managed_keys(monkeypatch):
    monkeypatch.setattr(settings, "langfuse_public_key", "pk-lf-test")
    monkeypatch.setattr(settings, "langfuse_secret_key", "sk-lf-test")


@pytest.mark.asyncio
async def test_missing_credentials_never_fetches(monkeypatch):
    monkeypatch.setattr(settings, "langfuse_secret_key", None)
    fetch = MagicMock()
    monkeypatch.setattr(langfuse, "get_prompt", fetch)
    assert await system_prompt("test", "local") == ("local", None)
    fetch.assert_not_called()


@pytest.mark.asyncio
async def test_managed_prompt_label_timeout_cache_and_link(monkeypatch, managed_keys):
    prompt = SimpleNamespace(compile=lambda: "managed", is_fallback=False)
    fetch = MagicMock(return_value=prompt)
    monkeypatch.setattr(langfuse, "get_prompt", fetch)
    monkeypatch.setattr(settings, "langfuse_prompt_label", "staging")
    assert await system_prompt("test", "local") == ("managed", prompt)
    assert fetch.call_args.kwargs == {"type": "text", "label": "staging", "fallback": "local",
        "cache_ttl_seconds": 60, "fetch_timeout_seconds": 2, "max_retries": 0}


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["", "{{missing}}", [], None])
async def test_invalid_managed_prompts_use_local(monkeypatch, managed_keys, invalid):
    monkeypatch.setattr(langfuse, "get_prompt", lambda *a, **k: SimpleNamespace(compile=lambda: invalid, is_fallback=False))
    assert await system_prompt("test", "local") == ("local", None)


@pytest.mark.asyncio
async def test_outage_and_sdk_fallback_do_not_link_fake_version(monkeypatch, managed_keys):
    fetch = MagicMock(side_effect=TimeoutError)
    monkeypatch.setattr(langfuse, "get_prompt", fetch)
    assert await system_prompt("test", "local") == ("local", None)
    fetch.side_effect = None
    fetch.return_value = SimpleNamespace(compile=lambda: "local", is_fallback=True)
    assert await system_prompt("test", "local") == ("local", None)


@pytest.mark.asyncio
async def test_preprocess_uses_managed_text_and_links_generation(monkeypatch):
    ref = object()
    monkeypatch.setattr(rag, "system_prompt", AsyncMock(return_value=("managed system", ref)))
    create = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
        content='{"corrected":"firma","search_query":"sigorta firmasi"}'))]))
    monkeypatch.setattr(rag._client.chat.completions, "create", create)
    assert await rag._preprocess("firma", []) == ("firma", "sigorta firmasi")
    assert create.call_args.kwargs["messages"][0]["content"] == "managed system"
    assert create.call_args.kwargs["langfuse_prompt"] is ref
