"""Managed system prompts with local defaults; seed with python -m app.prompts seed."""
import asyncio
import json
import logging
import re

logger = logging.getLogger(__name__)


async def system_prompt(name: str, fallback: str):
    from app.config import settings
    from app.observability import langfuse

    if not settings.langfuse_enabled:
        return fallback, None
    try:
        prompt = await asyncio.to_thread(
            langfuse.get_prompt, name, type="text", label=settings.langfuse_prompt_label,
            fallback=fallback, cache_ttl_seconds=60, fetch_timeout_seconds=2, max_retries=0,
        )
        text = prompt.compile()
        if not isinstance(text, str) or not text.strip() or re.search(r"\{\{.*?\}\}", text):
            raise ValueError("System prompt must be nonempty and contain no unresolved variables")
        return text, None if prompt.is_fallback else prompt
    except Exception as exc:
        logger.warning("Using local prompt %s (%s)", name, type(exc).__name__)
        return fallback, None


def seed():
    import os
    import subprocess
    from pathlib import Path
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    from app.config import settings
    from app.services.rag import _SYSTEM, _PREPROCESS_SYSTEM
    from app.services.categorizer import _SYSTEM as category_system
    from app.evaluation import _JUDGE_SYSTEM

    if not settings.langfuse_enabled:
        raise SystemExit("Langfuse credentials are required")
    env = {**os.environ, "LANGFUSE_HOST": settings.langfuse_base_url}

    def call(*args, body=None):
        command = ["npx", "--yes", "langfuse-cli", "api", "prompts", *args, "--json"]
        if body is not None:
            command += ["--body-file", "-"]
        result = subprocess.run(command, input=json.dumps(body) if body else None,
                                env=env, capture_output=True, text=True, check=True)
        response = json.loads(result.stdout[result.stdout.index("{"):])
        if response["status"] >= 400:
            raise RuntimeError(f"Langfuse prompts API returned {response['status']}")
        return response["body"]

    specs = {"babalar-query-preprocess": _PREPROCESS_SYSTEM, "babalar-rag-answer": _SYSTEM,
             "babalar-categorizer": category_system, "babalar-faithfulness-judge": _JUDGE_SYSTEM}
    for name, text in specs.items():
        existing = call("list", "--name", name)
        if any(item["name"] == name for item in existing["data"]):
            print(json.dumps({"name": name, "status": "exists; preserved"}))
            continue
        prompt = call("create", body={"name": name, "type": "text", "prompt": text,
            "labels": ["production", "staging"], "tags": ["babalar", "workshop"],
            "config": {"model": "gpt-4o-mini", "temperature": 0},
            "commitMessage": "Migrate existing system instructions without behavior changes"})
        print(json.dumps({"name": name, "version": prompt["version"], "labels": prompt["labels"]}))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["seed"])
    parser.parse_args()
    seed()
