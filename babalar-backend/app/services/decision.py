import re
from dataclasses import asdict, dataclass
from typing import Any

from app.config import settings
from langfuse import get_client, observe

_PHONE_RE = re.compile(
    r"(?<!\w)(?:\+?\d{1,3}[\s().-]*)?(?:\(?\d{2,5}\)?[\s().-]*)?\d{3,5}[\s().-]*\d{2,5}[\s().-]*\d{2,5}(?!\w)"
)
_EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]{1,64}@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")

_PII_BLOCK_MESSAGE = "Bu yanıtta kişisel veri paylaşma riski olduğu için gösteremiyorum."
_PII_REQUEST_MESSAGE = "Kişisel telefon numarası, e-posta veya adres gibi özel bilgileri paylaşamam."
_OUT_OF_SCOPE_MESSAGE = "Bu soru Babalar topluluk arşivinin kapsamı dışında görünüyor."
_LOW_GROUNDING_MESSAGE = "Bu konuda toplulukta yeterli güvenilir bilgi bulamadım."

_instrumented = False


@dataclass
class AnswerDecision:
    action: str = "show"
    block: bool = False
    reason: str | None = None
    replacement_answer: str | None = None
    pii_risk: float = 0.0
    out_of_scope: float = 0.0
    answer_grounded: float | None = None
    confidence: float | None = None
    source: str = "none"
    model: str | None = None


def _contains_pii(text: str) -> bool:
    if _EMAIL_RE.search(text):
        return True
    for match in _PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if len(digits) >= 9:
            return True
    return False


def _requests_private_contact(text: str) -> bool:
    lowered = text.lower()
    pii_terms = (
        "telefon",
        "tel no",
        "numara",
        "numarası",
        "numarasını",
        "mail",
        "email",
        "e-mail",
        "adres",
        "address",
        "phone",
    )
    request_terms = (
        "bul",
        "bulur musun",
        "var mı",
        "paylaş",
        "paylas",
        "ver",
        "gönder",
        "gonder",
        "find",
        "share",
        "give",
    )
    possessive_clues = ("'in", "'ın", "'un", "'ün", "nin", "nın", "nun", "nün", "his ", "her ")
    return (
        any(term in lowered for term in pii_terms)
        and any(term in lowered for term in request_terms)
        and any(clue in lowered for clue in possessive_clues)
    )


def _as_probability(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, number))


def _get_mapping_attr(obj: Any, name: str) -> Any:
    value = getattr(obj, name, None)
    return value if value is not None else {}


def _get_answer_field(answer: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(answer, dict) and name in answer:
            return answer[name]
        if hasattr(answer, name):
            return getattr(answer, name)
    return default


def _ensure_typesafe_instrumented() -> None:
    global _instrumented
    if _instrumented:
        return
    try:
        from openinference.instrumentation.typesafe import TypeSafeAIInstrumentor

        TypeSafeAIInstrumentor().instrument()
    except Exception:
        # Instrumentation is useful for richer Langfuse traces but should not
        # break the answer path if the package or OTel setup is unavailable.
        pass
    _instrumented = True


def _apply_thresholds(decision: AnswerDecision, found: bool) -> AnswerDecision:
    if decision.pii_risk >= settings.jev_pii_block_threshold:
        decision.action = "reject"
        decision.block = True
        decision.reason = "pii_risk"
        decision.replacement_answer = _PII_BLOCK_MESSAGE
    elif decision.out_of_scope >= settings.jev_out_of_scope_block_threshold:
        decision.action = "reject"
        decision.block = True
        decision.reason = "out_of_scope"
        decision.replacement_answer = _OUT_OF_SCOPE_MESSAGE
    elif (
        found
        and decision.answer_grounded is not None
        and decision.answer_grounded <= settings.jev_grounding_block_threshold
    ):
        decision.action = "reject"
        decision.block = True
        decision.reason = "low_grounding"
        decision.replacement_answer = _LOW_GROUNDING_MESSAGE
    elif decision.action in {"reject", "needs_review"}:
        decision.block = True
        decision.reason = decision.action
        decision.replacement_answer = _LOW_GROUNDING_MESSAGE
    return decision


@observe(name="decide-question", capture_input=False, capture_output=False)
async def decide_question(question: str) -> AnswerDecision:
    langfuse = get_client()
    langfuse.update_current_span(input={"question": question[:1000]})

    if _requests_private_contact(question):
        decision = AnswerDecision(
            action="reject",
            block=True,
            reason="pii_request",
            replacement_answer=_PII_REQUEST_MESSAGE,
            pii_risk=1.0,
            source="regex",
        )
        langfuse.update_current_span(output=asdict(decision))
        return decision

    decision = AnswerDecision(source="regex")
    langfuse.update_current_span(output=asdict(decision))
    return decision


@observe(name="decide-answer", capture_input=False, capture_output=False)
async def decide_answer(
    *,
    question: str,
    search_query: str,
    answer: str,
    context: str,
    found: bool,
    source_count: int,
) -> AnswerDecision:
    langfuse = get_client()
    langfuse.update_current_span(
        input={
            "question": question,
            "search_query": search_query,
            "found": found,
            "source_count": source_count,
            "answer_chars": len(answer),
            "context_chars": len(context),
        }
    )

    if _contains_pii(answer):
        decision = AnswerDecision(
            action="reject",
            block=True,
            reason="pii_regex",
            replacement_answer=_PII_BLOCK_MESSAGE,
            pii_risk=1.0,
            source="regex",
        )
        langfuse.update_current_span(output=asdict(decision))
        return decision

    if not settings.jev_enabled or not settings.typesafe_api_key:
        decision = AnswerDecision(source="disabled")
        langfuse.update_current_span(output=asdict(decision))
        return decision

    try:
        from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul
    except Exception:
        decision = AnswerDecision(source="unavailable")
        langfuse.update_current_span(output=asdict(decision))
        return decision

    _ensure_typesafe_instrumented()

    state = {
        "question": question[:1000],
        "search_query": search_query[:1000],
        "answer": answer[:3000],
        "retrieved_context": context[:8000],
        "found": found,
        "source_count": source_count,
    }
    questions = {
        "answer_action": Choice(
            instructions=(
                "What should the app do with `answer` for `question`, given `retrieved_context`? "
                "Choose reject for personal data exposure, unsupported claims, unsafe advice, or clear scope mismatch."
            ),
            criteria={
                "show": "The answer is supported by retrieved context and safe to show.",
                "show_with_caveat": "The answer is mostly usable but should be treated cautiously.",
                "reject": "The answer should not be shown.",
                "needs_review": "A human should review this before showing it.",
            },
        ),
        "answer_grounded": Noul(
            instructions="The `answer` is sufficiently supported by `retrieved_context` and does not add unsupported claims."
        ),
        "out_of_scope": Noul(
            instructions="The `question` is outside the Babalar WhatsApp community archive assistant's scope."
        ),
        "pii_risk": Noul(
            instructions="The `answer` exposes personal data such as a private phone number, email, address, or identifier."
        ),
    }

    try:
        async with AsyncTypeSafeClient() as client:
            response = await client.system_one(
                model=settings.jev_model,
                state=state,
                questions=questions,
            )
    except Exception as exc:
        decision = AnswerDecision(source="error")
        langfuse.update_current_span(output={**asdict(decision), "error": exc.__class__.__name__})
        return decision

    choices = _get_mapping_attr(response, "choices")
    nouls = _get_mapping_attr(response, "nouls")
    action_answer = choices.get("answer_action") if hasattr(choices, "get") else None
    grounded_answer = nouls.get("answer_grounded") if hasattr(nouls, "get") else None
    out_of_scope_answer = nouls.get("out_of_scope") if hasattr(nouls, "get") else None
    pii_answer = nouls.get("pii_risk") if hasattr(nouls, "get") else None

    decision = AnswerDecision(
        action=str(_get_answer_field(action_answer, "choice", default="show")),
        confidence=_get_answer_field(action_answer, "confidence"),
        pii_risk=_as_probability(_get_answer_field(pii_answer, "noul", "probability")),
        out_of_scope=_as_probability(_get_answer_field(out_of_scope_answer, "noul", "probability")),
        answer_grounded=_as_probability(_get_answer_field(grounded_answer, "noul", "probability"), default=1.0),
        source="jev",
        model=str(getattr(response, "model", settings.jev_model)),
    )
    decision = _apply_thresholds(decision, found=found)
    langfuse.update_current_span(output=asdict(decision))
    return decision
