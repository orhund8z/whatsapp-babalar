import asyncio
import json

from openai import RateLimitError
from app.config import settings  # noqa: F401  (sets LANGFUSE_TRACING_ENABLED before langfuse import)
from app.observability import langfuse as _telemetry
from app.prompts import system_prompt
from langfuse import get_client, observe
from langfuse.openai import AsyncOpenAI

_client = AsyncOpenAI(api_key=settings.openai_api_key)

_CATEGORIES = [
    "araba", "saglik", "resmi-daire", "cocuk", "ikinci-el",
    "konut", "yemek-restoran", "is-kariyer", "egitim", "spor-eglence", "genel",
]

_CATS_STR = ", ".join(_CATEGORIES)

_CHUNK_SIZE = 25  # messages per API call

_SYSTEM = (
    "You will be given numbered WhatsApp messages. "
    "Assign each message to one of these categories: " + _CATS_STR + ".\n"
    "Return only a JSON array, example: [\"yemek-restoran\", \"genel\", \"araba\"]. "
    "Write nothing else."
)

_SEM = asyncio.Semaphore(5)  # max 5 concurrent chunk calls


async def _categorize_chunk(contents: list[str]) -> list[str]:
    numbered = "\n".join(f"{i+1}. {c[:500]}" for i, c in enumerate(contents))
    async with _SEM:
        system, prompt_ref = await system_prompt("babalar-categorizer", _SYSTEM)
        for attempt in range(4):
            try:
                response = await _client.chat.completions.create(
                    model="gpt-4o-mini",
                    max_tokens=200,
                    temperature=0,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": numbered},
                    ],
                    name="categorize-messages",
                    langfuse_prompt=prompt_ref,
                )
                raw = response.choices[0].message.content.strip()
                parsed = json.loads(raw)
                if isinstance(parsed, list) and len(parsed) == len(contents):
                    return [c.strip().lower() if c.strip().lower() in _CATEGORIES else "genel" for c in parsed]
                break
            except RateLimitError as e:
                # Daily limit exhausted — retrying won't help, fail immediately
                if "requests per day" in str(e) or "RPD" in str(e):
                    raise
                if attempt == 3:
                    raise
                await asyncio.sleep(2 ** attempt)
            except json.JSONDecodeError:
                break
            except Exception:
                if attempt == 3:
                    raise
                await asyncio.sleep(2 ** attempt)
    return ["genel"] * len(contents)


async def categorize(content: str) -> str:
    results = await _categorize_chunk([content])
    return results[0]


@observe(name="categorize-batch", capture_input=False, capture_output=False)
async def categorize_batch(contents: list[str]) -> list[str]:
    chunks = [contents[i:i + _CHUNK_SIZE] for i in range(0, len(contents), _CHUNK_SIZE)]
    get_client().update_current_span(input={"message_count": len(contents), "chunk_count": len(chunks)})
    results = await asyncio.gather(*[_categorize_chunk(chunk) for chunk in chunks])
    categories = [cat for chunk_result in results for cat in chunk_result]
    get_client().update_current_span(output={"category_counts": {c: categories.count(c) for c in set(categories)}})
    return categories
