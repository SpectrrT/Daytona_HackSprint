"""Every Red, Blue and grader model call goes through here. Owner: Ryan.

- Claude on Amazon Bedrock via the Anthropic SDK's Mantle client (model ids carry an
  `anthropic.` prefix). Model, fallback and effort come from .env.
- Structured output: pass a pydantic model, get a validated instance back.
- Determinism: current Claude models reject `temperature`, so the spec's "temperature 0" can't
  be met. Instead every response is cached on disk by a hash of the request (LLM_CACHE=1), so a
  recorded run replays identically and re-runs during rehearsal cost nothing.
- Refusals: if the model declines (stop_reason == "refusal"), the same request is re-sent once
  on CLAUDE_FALLBACK_MODEL.
- Arize: telemetry.arize.setup_tracing() instruments the Anthropic SDK, so these calls are traced
  without extra code here (M2).
"""

from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

CACHE_DIR = Path(os.getenv("LLM_CACHE_DIR", "runs/llm_cache"))


class ModelRefused(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _client():
    from anthropic import AnthropicBedrockMantle

    return AnthropicBedrockMantle(aws_region=os.getenv("AWS_REGION", "us-east-1"))


def _cache_key(model: str, system: str, prompt: str, schema: type[BaseModel], effort: str) -> str:
    blob = json.dumps(
        [model, system, prompt, schema.model_json_schema(), effort], sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


def ask(
    prompt: str,
    output: type[T],
    *,
    system: str = "",
    effort: str | None = None,
    max_tokens: int = 16000,
    span_name: str = "llm",
) -> T:
    """One structured model call. Returns an instance of `output`, validated."""
    model = os.getenv("CLAUDE_MODEL", "anthropic.claude-opus-5-5")
    effort = effort or os.getenv("CLAUDE_EFFORT", "medium")
    use_cache = os.getenv("LLM_CACHE", "1") == "1"

    key = _cache_key(model, system, prompt, output, effort)
    cache_file = CACHE_DIR / f"{key}.json"
    if use_cache and cache_file.exists():
        return output.model_validate_json(cache_file.read_text())

    extra = {"system": system} if system else {}
    result = None
    for attempt_model in (model, os.getenv("CLAUDE_FALLBACK_MODEL")):
        if not attempt_model:
            continue
        response = _client().messages.parse(
            model=attempt_model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
            output_format=output,
            output_config={"effort": effort},
            **extra,
        )
        if response.stop_reason != "refusal":
            result = response.parsed_output
            break
    if result is None:
        raise ModelRefused(f"{span_name}: every model declined the request")

    if use_cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(result.model_dump_json())
    return result
