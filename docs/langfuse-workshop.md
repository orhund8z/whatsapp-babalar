# Langfuse and JEV Workshop

The first workshop slice adds retrieval/result scores, user thumbs, a labelled
40-case dataset, repeatable experiments, literal evidence checks, and an optional
LLM faithfulness judge. JEV decision scores were already present. Existing history
and import tests also predate this change.

## Try It

Open the chat, ask a question, then use the thumbs buttons under its answer. In
Langfuse, inspect that trace's scores: `found`, `source_count`, `top_similarity`,
`retrieval_count`, `answer_blocked`, `decision_source`, and `user-thumbs`. The JEV
child observation also carries `answer_grounded`, `pii_risk`, `out_of_scope`, and
`answer_action`. `decision_source=jev` confirms a real JEV call; `regex` means the
local privacy guard acted first. `error`, `unavailable`, and `disabled` are not
successful JEV evaluations.

From the repository root, with the backend dependencies installed:

```bash
cd babalar-backend
python -m app.evaluation seed
python -m app.evaluation run --limit 8 --llm-judge
python -m app.evaluation run --run-name full-demo
```

Or on the deployed server:

```bash
cd /app
docker compose -f docker-compose.prod.yml exec backend python -m app.evaluation seed
docker compose -f docker-compose.prod.yml exec backend python -m app.evaluation run --limit 8 --llm-judge
```

Required configuration: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
`LANGFUSE_BASE_URL`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY`, and `JEV_ENABLED=true`.
Local commands load the repository `.env`; Docker uses its existing environment.
The SDK is pinned to Langfuse 4.17.0, the version validated for this integration.

The runner prints the experiment URL. Open `babalar-workshop-v1` in Langfuse and
compare runs. Seeding uses stable item IDs and is safe to repeat. The default
experiment concurrency is two; `--limit 8` selects a balanced smoke sample.

## Dataset and Scores

The demo uses **synthetic** community snippets: 20 supported Turkish questions,
10 absent-information questions, and 10 JEV/guardrail cases with supported claims,
wrong quantities, invented URLs, conflicting evidence, fabricated PII, and scope
mismatch. Names/contact details are fictional. These are not 40 real WhatsApp
questions and do not benchmark pgvector retrieval.

Generation fixtures call the same `generate_answer` function as live RAG. Decision
fixtures deliberately send a candidate answer to the real decision layer. This
separates generation errors from decision errors and provides visible negative
controls. PII cases should be rejected by the regex guard before JEV runs.

| Score | Meaning |
|---|---|
| `found_accuracy` | Delivered found/abstention outcome matches the label |
| `reference_facts` | Fraction of reference strings present in the answer |
| `decision_accuracy` | Block/show outcome matches the decision label |
| `decision_available` | Decision dependency did not fail or disable itself |
| `url_groundedness` | Fraction of answer URLs literally present in context |
| `number_groundedness` | Fraction of answer numbers present in context |
| `llm_faithfulness` | Optional GPT-4o-mini judgement of context support |
| `avg_*` | Run-level averages of the applicable item scores |

Literal URL/number checks are diagnostics, not a proof of truth or faithfulness.
Empty claim sets score 1 (no unsupported literal claim). They cannot detect a
reversed opinion or distinguish two different claims using the same number.
The optional LLM judge and JEV provide separate signals; their scores need not agree.
An experiment can complete while quality scores reveal failures. Missing task
results or unavailable JEV dependencies cause a nonzero exit; no CI regression
gate is installed in this first slice.

For a real retrieval benchmark, author a JSON array with stable `id`, `input`
(`kind: "archive"`, `question`), and `expected_output` (`found`, optionally
`reference_facts`), plus metadata. Review/redact questions before uploading them.
Use a separate dataset name:

```bash
python -m app.evaluation seed --dataset-name babalar-archive-v1 --dataset-file /path/to/labelled-cases.json
python -m app.evaluation run --dataset-name babalar-archive-v1
```

Archive items exercise preprocessing, embedding, pgvector retrieval, generation,
and JEV against the configured PostgreSQL database. The optional fixture-context
judge is skipped for archive items because their labelled input does not include
retrieved context. Keep this benchmark separate from synthetic demo scores.

## Trace and Feedback Controls

The SDK's export-stage `mask_otel_spans` hook covers both Langfuse and third-party
OpenTelemetry attributes. It redacts email/phone patterns, WhatsApp numeric IDs,
structured sender fields, and `[time | sender]` context labels. This is pattern-based
redaction, not complete PII detection; it does not reliably identify free-text names
or addresses. This export hook does not change application data or model input.
The separate RAG privacy scrubber also removes contact details and IBANs from
questions, history, and retrieved message text before model calls.

Feedback uses an authenticated endpoint and a seven-day signed token bound to the
user and trace. Re-rating updates one stable score ID rather than creating repeated
votes. No Langfuse secret is sent to the browser. Tracing remains disabled when keys
are absent. A CI quality gate remains separate follow-up work.

## Managed Prompts

Four existing system prompts are now versioned in Langfuse as text prompts:
`babalar-query-preprocess`, `babalar-rag-answer`, `babalar-categorizer`, and
`babalar-faithfulness-judge`. Version 1 preserves the original instructions and
has both `production` and `staging` labels. Each OpenAI generation links to the
actual fetched prompt version. Model parameters, user messages/history, and
JEV's typed decision questions/thresholds remain in code.

```bash
cd babalar-backend
python -m app.prompts seed
LANGFUSE_PROMPT_LABEL=staging python -m app.evaluation run --limit 8 --llm-judge
```

Seeding requires Node/npx for the Langfuse CLI and preserves prompts that already
exist; it never replaces workshop edits. Runtime fetching only uses the Python
SDK. Live traffic defaults to `LANGFUSE_PROMPT_LABEL=production`. Save edits as a
new version with `staging`, evaluate, then move `production` to the tested version.
Rollback means moving `production` back. The SDK cache lasts 60 seconds and may
serve a stale version during background refresh, so updates are not instantaneous.
Model/config settings displayed in Langfuse are informational; model calls still
use code-defined parameters.

Fetches run outside the async event loop with a two-second timeout and no retries.
Missing credentials, unavailable prompts, malformed/blank templates, and unresolved
variables use the local original instructions. These system prompts currently have
no template variables. Fallback generations are not linked to a fake prompt version.

References: [Experiments SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk),
[Masking](https://langfuse.com/docs/observability/features/masking),
[JEV as a judge](https://langfuse.com/docs/evaluation/evaluation-methods/jev-as-a-judge).
