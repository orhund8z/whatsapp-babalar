import asyncio
import json
import re
from contextlib import nullcontext
from datetime import timedelta

from openai import RateLimitError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings  # noqa: F401  (sets LANGFUSE_TRACING_ENABLED before langfuse import)
from app.models.models import AdminConfig
from app.services.decision import decide_answer, decide_question
from app.services.embedding import embed
from langfuse import get_client, observe, propagate_attributes
from langfuse.openai import AsyncOpenAI

_LID_RE = re.compile(r"^\d+@lid$")

_client = AsyncOpenAI(api_key=settings.openai_api_key)

_PREPROCESS_SYSTEM = """You are a Turkish text processing assistant. You have two tasks:

1. Produce a search_query optimized for vector search.
   - If there is prior conversation, resolve the current question in that context and extract a standalone search query.
     Example: Previous topic "car insurance", current question "which company" → search_query: "car insurance company recommendation"
   - For "any others / anything else / alternative" style questions, generate a query that looks for DIFFERENT aspects of the previous topic.
     Example: previous "döner place recommendation" → search_query: "döner kebap different venue"
   - Do NOT add "München" to the search_query — it degrades embedding quality.
   - Keep German official terms and proper nouns as-is (Ausländerbehörde, Anmeldung, TÜV, Standesamt, etc.).
   - If the question is very short or ambiguous (1-3 words), expand using context; if no context, keep as-is.
   - If there is no prior topic, search_query should equal corrected.

2. Fix missing Turkish characters if written incorrectly (s→ş, g→ğ, i→ı, o→ö, u→ü, c→ç, etc.).
   Do not correct German words.

Always respond in exactly this JSON format:
{"corrected": "corrected question text", "search_query": "standalone question for embedding search"}"""

_SYSTEM = """You are someone who has read all conversations in the "Münihli Babalar" WhatsApp groups and committed them to memory. You answer questions by looking at what was discussed in those conversations. Always respond in Turkish.

YOUR IDENTITY:
- You have memorized all dialogues, shared experiences, recommendations, links, and discussions from this community.
- You have no general knowledge or personal opinions — you only know what was discussed in these groups.

WHEN ANSWERING — FOLLOW THIS ORDER:
First think in the reasoning field: "What comes up in the messages related to this question? Who said what? Which links were shared? Are there conflicting opinions?" — then write the answer.

ANSWER RULES:
1. Relay ONLY information from the provided messages. NEVER add your own general knowledge, assumptions, or opinions.
2. Include everything concrete: names, companies, prices, addresses, dates, personal experiences, warnings.
3. If messages contain URLs or links, list them at the end under a separate "🔗 Linkler:" section.
4. If there are multiple recommendations/experiences, list them as bullet points.
5. If there are conflicting opinions, relay them as "X found it positive, Y had a negative experience".
6. If information is partial or incomplete, say "Toplulukta yalnızca şu kadarı geçiyor: ..." — do not fill gaps or complete information.

NEVER:
- Add general knowledge, assumptions, or commentary ("Generally this is the case", "Check the official site", etc.)
- Generate information not present in the messages
- Repeat a previous answer

PRIOR CONVERSATION CONTEXT:
- "Any others / different recommendation" → if messages contain something DIFFERENT from before, present it; otherwise say "Toplulukta başka bilgi geçmiyor".

IF NO RELEVANT INFORMATION EXISTS:
Return "found": false. Do not guess or provide general information.

Always respond in exactly this JSON format — reasoning FIRST, then found and answer:
{"reasoning": "What comes up in the messages: [brief internal analysis — not shown to user]", "found": true, "answer": "answer shown to user in Turkish"}"""


async def _get_top_k(db: AsyncSession) -> int:
    result = await db.execute(select(AdminConfig).where(AdminConfig.key == "rag_top_k"))
    row = result.scalar_one_or_none()
    return int(row.value) if row else 40


async def _preprocess(question: str, history: list[dict]) -> tuple[str, str]:
    """Returns (corrected_question, search_query).

    search_query is a context-resolved standalone query for embedding —
    e.g. "hangi firma" after a car insurance exchange becomes a full standalone query.
    """
    try:
        user_content = question[:500]
        if history:
            recent = history[-6:]  # last 3 exchanges
            history_text = "\n".join(
                f"{'User' if h['role'] == 'user' else 'Assistant'}: {h['content'][:200]}"
                for h in recent
            )
            user_content = f"[Previous conversation]\n{history_text}\n\n[Current question]\n{question[:500]}"

        resp = await _client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=300,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _PREPROCESS_SYSTEM},
                {"role": "user", "content": user_content},
            ],
            name="preprocess-query",
        )
        parsed = json.loads(resp.choices[0].message.content)
        corrected = parsed.get("corrected", question).strip() or question
        search_query = parsed.get("search_query", corrected).strip() or corrected
        return corrected, search_query
    except Exception:
        return question, question  # fail open


async def _fetch_thread_context(db: AsyncSession, top_results: list) -> list:
    """For each top result, fetch adjacent messages from the same group within ±3 minutes.

    WhatsApp replies often don't repeat the topic — fetching neighbors reconstructs
    the conversation thread and gives the LLM the missing implicit context.
    """
    seen_keys: set = set()
    thread_rows = []

    # Only expand context for the top 8 most relevant results
    for row in top_results[:8]:
        window = timedelta(minutes=3)
        neighbors = await db.execute(
            text("""
                SELECT m.id, m.group_id, m.content, m.sender_name, m.sent_at, g.group_name,
                       0.0 AS similarity
                FROM messages m
                JOIN wa_groups g ON g.id = m.group_id
                WHERE m.group_id = :gid
                  AND m.sent_at BETWEEN :ts_start AND :ts_end
                  AND length(m.content) >= 15
                ORDER BY m.sent_at
                LIMIT 15
            """),
            {"gid": row.group_id, "ts_start": row.sent_at - window, "ts_end": row.sent_at + window},
        )
        for n in neighbors:
            key = n.id
            if key not in seen_keys:
                seen_keys.add(key)
                thread_rows.append(n)

    return thread_rows


@observe(name="rag-answer", capture_input=False, capture_output=False)
async def answer(db: AsyncSession, question: str, history: list[dict] | None = None, user_id: str | None = None) -> dict:
    history = history or []
    langfuse = get_client()
    langfuse.update_current_span(input={"question": question, "history_turns": len(history)})

    attrs = propagate_attributes(user_id=user_id, tags=["rag"]) if user_id else nullcontext()
    with attrs:
        question_decision = await decide_question(question)
        if question_decision.block:
            langfuse.update_current_span(
                output={
                    "found": False,
                    "source_count": 0,
                    "decision": question_decision.reason,
                    "decision_source": question_decision.source,
                }
            )
            return {
                "answer": question_decision.replacement_answer or "Bu konuda yardımcı olamam.",
                "sources": [],
            }

        normalized, search_query = await _preprocess(question, history)

        top_k = await _get_top_k(db)
        query_embedding = await embed(search_query)

        with langfuse.start_as_current_observation(
            as_type="span",
            name="pgvector-search",
            input={"search_query": search_query, "top_k": top_k},
        ) as search_span:
            rows = await db.execute(
                text("""
                    SELECT m.id, m.group_id, m.content, m.sender_name, m.sent_at, m.category, g.group_name,
                           1 - (m.embedding <=> CAST(:emb AS vector)) AS similarity
                    FROM messages m
                    JOIN wa_groups g ON g.id = m.group_id
                    WHERE m.embedding IS NOT NULL
                      AND length(m.content) >= 40
                    ORDER BY m.embedding <=> CAST(:emb AS vector)
                    LIMIT :k
                """),
                {"emb": str(query_embedding), "k": top_k},
            )
            results = rows.fetchall()

            # Filter out low-similarity results to reduce noise in the LLM context
            results = [r for r in results if r.similarity >= 0.45]
            search_span.update(output={"result_count": len(results)})

        if not results:
            langfuse.update_current_span(output={"found": False, "reason": "no_similarity_matches"})
            return {"answer": "Bu konuda toplulukta yeterli bilgi bulamadım.", "sources": []}

        # Expand each top result with its conversation thread neighbors
        thread_neighbors = await _fetch_thread_context(db, results)

        # Merge: top results + thread neighbors, deduplicate by message id
        result_ids = {r.id for r in results}
        result_sims = {r.id: r.similarity for r in results}
        extra = [n for n in thread_neighbors if n.id not in result_ids]
        all_msgs = results + extra

        # Group into conversation clusters: same group, messages within 10 minutes of each other
        all_msgs_sorted = sorted(all_msgs, key=lambda r: (r.group_name, r.sent_at))
        clusters: list[list] = []
        current: list = []
        for msg in all_msgs_sorted:
            if not current:
                current.append(msg)
            else:
                last = current[-1]
                gap = abs((msg.sent_at - last.sent_at).total_seconds())
                if msg.group_name == last.group_name and gap <= 600:
                    current.append(msg)
                else:
                    clusters.append(current)
                    current = [msg]
        if current:
            clusters.append(current)

        # Sort clusters by their highest similarity score (most relevant first)
        def cluster_score(c: list) -> float:
            return max(result_sims.get(m.id, 0.0) for m in c)

        clusters.sort(key=cluster_score, reverse=True)

        seen_groups: dict[str, str] = {}
        context_parts = []
        for cluster in clusters:
            date_str = cluster[0].sent_at.strftime("%d.%m.%Y")
            group_name = cluster[0].group_name
            header = f"=== {group_name} | {date_str} ==="
            lines = [header]
            for msg in cluster:
                sender = "Anonim" if not msg.sender_name or _LID_RE.match(msg.sender_name) else msg.sender_name
                time_str = msg.sent_at.strftime("%H:%M")
                lines.append(f"[{time_str} | {sender}] {msg.content}")
                sim = result_sims.get(msg.id, 0.0)
                if sim >= 0.52 and group_name not in seen_groups:
                    seen_groups[group_name] = date_str
            context_parts.append("\n".join(lines))

        sources = [{"group": g, "date": d} for g, d in seen_groups.items()]
        context = "\n\n---\n\n".join(context_parts)
        prompt = f"Community messages:\n\n{context}\n\nQuestion: {normalized}"

        # Build messages with conversation history so the LLM has full context
        messages: list[dict] = [{"role": "system", "content": _SYSTEM}]
        for h in history[-6:]:  # last 3 exchanges
            if h.get("role") in ("user", "assistant"):
                messages.append({"role": h["role"], "content": h["content"][:800]})
        messages.append({"role": "user", "content": prompt})

        for attempt in range(5):
            try:
                response = await _client.chat.completions.create(
                    model="gpt-4o-mini",
                    max_tokens=1800,
                    temperature=0,
                    response_format={"type": "json_object"},
                    messages=messages,
                    name="generate-answer",
                )
                raw = response.choices[0].message.content
                parsed = json.loads(raw)
                found = parsed.get("found", False)
                answer_text = (parsed.get("answer") or "").strip()
                # Model sometimes leaves "answer" blank when found=false instead of writing a message.
                if not found or not answer_text:
                    answer_text = "Bu konuda toplulukta yeterli bilgi bulamadım."

                decision = await decide_answer(
                    question=normalized,
                    search_query=search_query,
                    answer=answer_text,
                    context=context,
                    found=found,
                    source_count=len(sources),
                )
                if decision.block:
                    langfuse.update_current_span(
                        output={
                            "found": False,
                            "source_count": 0,
                            "decision": decision.reason,
                            "decision_source": decision.source,
                        }
                    )
                    return {"answer": decision.replacement_answer or "Bu konuda toplulukta yeterli bilgi bulamadım.", "sources": []}

                langfuse.update_current_span(
                    output={
                        "found": found,
                        "source_count": len(sources),
                        "decision": decision.action,
                        "decision_source": decision.source,
                    }
                )
                return {"answer": answer_text, "sources": sources if found else []}  # reasoning is internal, not returned
            except RateLimitError as e:
                if "requests per day" in str(e) or "RPD" in str(e):
                    raise
                if attempt == 4:
                    raise
                await asyncio.sleep(2 ** attempt)
