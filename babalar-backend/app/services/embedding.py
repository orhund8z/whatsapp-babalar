from app.config import settings  # noqa: F401  (sets LANGFUSE_TRACING_ENABLED before langfuse import)
from app.observability import langfuse as _telemetry
from langfuse.openai import AsyncOpenAI

_client = AsyncOpenAI(api_key=settings.openai_api_key)
_MODEL = "text-embedding-3-small"


async def embed(text: str) -> list[float]:
    text = text.replace("\n", " ").strip()
    response = await _client.embeddings.create(input=text, model=_MODEL)
    return response.data[0].embedding


async def embed_batch(texts: list[str]) -> list[list[float]]:
    cleaned = [t.replace("\n", " ").strip() for t in texts]
    response = await _client.embeddings.create(input=cleaned, model=_MODEL)
    return [item.embedding for item in response.data]
