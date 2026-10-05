import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.eval_data import demo_cases
from app.observability import mask_otel_spans, redact
from app.services.quality import evidence_scores
from app.services.feedback import feedback_token, feedback_score_id, verify_feedback
from app.api import chat
from app.auth import get_current_user


def test_evidence_detects_invented_urls_and_numbers():
    scores = evidence_scores("120 euro. https://example.org/wrong", "120,00 euro. https://example.org/right")
    assert scores == {"url_groundedness": 0.0, "number_groundedness": 1.0}
    assert evidence_scores("250 euro", "120 euro")["number_groundedness"] == 0.0
    assert evidence_scores("Bilgi bulunamadı.", "") == {"url_groundedness": 1.0, "number_groundedness": 1.0}


def test_masking_covers_nested_sdk_and_external_otel_attributes():
    payload = {"sender_name": "Private Name", "messages": [{"content": "[14:30 | Private Name] +49 151 00000000 person@example.test 123456789@lid"}]}
    result = mask_otel_spans(params=SimpleNamespace(spans={"span": SimpleNamespace(attributes={
        "langfuse.observation.input": json.dumps(payload), "gen_ai.prompt.0.content": payload["messages"][0]["content"]})}))
    masked = result.span_patches["span"].set_attributes
    assert all("Private Name" not in value and "person@example.test" not in value and "123456789@lid" not in value for value in masked.values())
    assert json.loads(masked["langfuse.observation.input"])["sender_name"] == "[REDACTED]"
    assert "[PHONE]" in masked["gen_ai.prompt.0.content"]
    assert payload["sender_name"] == "Private Name"  # original application data is unchanged
    assert redact({"value": 0.52}) == {"value": 0.52}


def test_feedback_proof_is_bound_to_user_and_trace():
    trace = "a" * 32
    token = feedback_token(trace, "owner")
    assert verify_feedback(token, trace, "owner")
    assert not verify_feedback(token, trace, "other-user")
    assert not verify_feedback(token, "b" * 32, "owner")
    assert not verify_feedback("broken", trace, "owner")
    assert feedback_score_id(trace, "owner") == feedback_score_id(trace, "owner")
    assert feedback_score_id(trace, "owner") != feedback_score_id(trace, "other-user")


def test_feedback_route_uses_one_score_id_and_rejects_forgery(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(chat, "langfuse", client)
    monkeypatch.setattr(chat.settings, "langfuse_public_key", "pk-lf-test")
    monkeypatch.setattr(chat.settings, "langfuse_secret_key", "sk-lf-test")
    app = FastAPI()
    app.include_router(chat.router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="owner")
    test_client = TestClient(app)
    trace = "a" * 32
    payload = {"trace_id": trace, "feedback_token": feedback_token(trace, "owner"), "value": 1}
    assert test_client.post("/api/chat/feedback", json=payload).status_code == 200
    first = client.create_score.call_args.kwargs
    payload["value"] = 0
    assert test_client.post("/api/chat/feedback", json=payload).status_code == 200
    assert client.create_score.call_args.kwargs["score_id"] == first["score_id"]
    assert client.create_score.call_args.kwargs["data_type"] == "BOOLEAN"
    payload["feedback_token"] = feedback_token(trace, "someone-else")
    assert test_client.post("/api/chat/feedback", json=payload).status_code == 403
    assert client.create_score.call_count == 2


def test_dataset_is_balanced_synthetic_and_stable():
    cases = demo_cases()
    assert len(cases) == 40
    assert len({case["id"] for case in cases}) == 40
    assert sum(case["input"]["kind"] == "decision" for case in cases) == 10
    assert sum(case["expected_output"].get("found") is False for case in cases) == 10
    assert all(case["metadata"]["provenance"].startswith("synthetic") for case in cases)


@pytest.mark.asyncio
async def test_blocked_question_emits_scores_without_retrieval(monkeypatch):
    from app.services import rag
    from app.services.decision import AnswerDecision
    telemetry = MagicMock()
    telemetry.get_current_trace_id.return_value = "a" * 32
    monkeypatch.setattr(rag, "get_client", lambda: telemetry)
    monkeypatch.setattr(rag, "decide_question", AsyncMock(return_value=AnswerDecision(block=True, source="regex", replacement_answer="Blocked")))
    embed = AsyncMock()
    monkeypatch.setattr(rag, "embed", embed)
    result = await rag.answer(MagicMock(), "Private contact request")
    assert result["found"] is False and result["sources"] == []
    assert result["blocked"] is True
    assert not embed.called
    names = {call.kwargs["name"] for call in telemetry.score_current_trace.call_args_list}
    assert {"found", "top_similarity", "source_count", "answer_blocked", "decision_source"} <= names


@pytest.mark.asyncio
async def test_jev_generation_records_actual_model_and_tokens(monkeypatch):
    import typesafe_sdk
    from app.services import decision
    response = SimpleNamespace(model="jev-1.13.0", usage=SimpleNamespace(input_tokens=90, output_tokens=8),
        choices={"answer_action": {"choice": "show"}},
        nouls={"answer_grounded": {"noul": 0.9}, "out_of_scope": {"noul": 0.1}, "pii_risk": {"noul": 0.01}},
        answers={"answer_action": SimpleNamespace(model_dump=lambda **kwargs: {"choice": "show"})})
    api = MagicMock()
    api.__aenter__ = AsyncMock(return_value=api)
    api.__aexit__ = AsyncMock(return_value=False)
    api.system_one = AsyncMock(return_value=response)
    monkeypatch.setattr(typesafe_sdk, "AsyncTypeSafeClient", lambda: api)
    monkeypatch.setattr(decision.settings, "jev_enabled", True)
    monkeypatch.setattr(decision.settings, "typesafe_api_key", "test")
    monkeypatch.setattr(decision, "_ensure_typesafe_instrumented", lambda: None)
    telemetry = MagicMock()
    monkeypatch.setattr(decision, "get_client", lambda: telemetry)
    result = await decision.decide_answer(question="Ücret?", search_query="Ücret?", answer="120 euro.",
                                          context="120 euro.", found=True, source_count=1)
    assert result.source == "jev" and not result.block
    generation = telemetry.start_as_current_observation.return_value.__enter__.return_value
    assert generation.update.call_args.kwargs["usage_details"] == {"input": 90, "output": 8}
    assert generation.update.call_args.kwargs["model"] == "jev-1.13.0"
