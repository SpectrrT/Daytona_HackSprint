"""Arize AX tracing and per-generation logging (M2). Owner: Ryan.

setup_tracing()   registers an OTel tracer provider with Arize and instruments the Anthropic SDK,
                  so every Red, Blue and grader model call (agents/llm.py) is traced automatically.
log_generation()  one span per generation with the verdict summary, one child span per world.
                  TODO(Ryan): also log each generation's verdicts as an Arize *experiment* (the
                  spec's M2) so the survival curve is a first-class chart in Arize; the span
                  attributes below are the data for it.

Both are no-ops when ARIZE_SPACE_ID / ARIZE_API_KEY are unset, so nothing else depends on Arize.
"""

from __future__ import annotations

import os

from opentelemetry import trace

from contracts import BluePlan, GenDone, WorldResult

_enabled = False


def setup_tracing() -> bool:
    global _enabled
    if _enabled:
        return True
    if not (os.getenv("ARIZE_SPACE_ID") and os.getenv("ARIZE_API_KEY")):
        return False
    from arize.otel import register
    from openinference.instrumentation.anthropic import AnthropicInstrumentor

    provider = register(
        space_id=os.environ["ARIZE_SPACE_ID"],
        api_key=os.environ["ARIZE_API_KEY"],
        project_name=os.getenv("ARIZE_PROJECT_NAME", "antibody"),
        verbose=False,
    )
    AnthropicInstrumentor().instrument(tracer_provider=provider)
    _enabled = True
    return True


def log_generation(summary: GenDone, results: list[WorldResult], plan: BluePlan) -> None:
    if not _enabled:
        return
    tracer = trace.get_tracer("antibody.arena")
    with tracer.start_as_current_span(f"generation {summary.generation}") as span:
        span.set_attribute("antibody.generation", summary.generation)
        span.set_attribute("antibody.exam", summary.exam)
        span.set_attribute("antibody.mode", summary.mode)
        span.set_attribute("antibody.plan_id", plan.id)
        span.set_attribute(
            "antibody.survival_rate", summary.survived / summary.attack_worlds if summary.attack_worlds else 0.0
        )
        span.set_attribute("antibody.dollars_lost", summary.dollars_lost)
        span.set_attribute("antibody.false_alarms", summary.false_alarms)
        span.set_attribute("antibody.seconds", summary.seconds)
        for result in results:
            with tracer.start_as_current_span(f"world {result.world_id}") as world_span:
                for key, value in result.model_dump().items():
                    if value is not None:
                        world_span.set_attribute(f"antibody.world.{key}", value)
