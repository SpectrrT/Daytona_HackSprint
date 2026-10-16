"""Export bounded metadata as real OpenInference spans. Never log prompts or keys."""
import contextlib
import json
import logging
import os
import sys


def export_span(record):
    from arize.otel import register, Transport
    from opentelemetry import trace
    from opentelemetry.sdk.trace.id_generator import IdGenerator
    from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags, Status, StatusCode

    class Identifiers(IdGenerator):
        def generate_trace_id(self):
            return int(record["traceId"], 16)

        def generate_span_id(self):
            return int(record["spanId"], 16)

    failed = []

    class ExportErrors(logging.Handler):
        def emit(self, item):
            if item.levelno >= logging.ERROR:
                failed.append(True)

    handler = ExportErrors()
    logging.getLogger("opentelemetry").addHandler(handler)
    provider = register(space_id=os.environ["ARIZE_SPACE_ID"], api_key=os.environ["ARIZE_API_KEY"], project_name="hollow-purple", endpoint="https://otlp.arize.com/v1/traces", transport=Transport.HTTP, batch=False, verbose=False, set_global_tracer_provider=False)
    # OpenInference's provider exposes the standard SDK IdGenerator constructor
    # through its tracer provider. Span IDs are assigned before export so every
    # independent worker can preserve the run/role parent relationship.
    provider.id_generator = Identifiers()
    context = None
    if record.get("parentSpanId"):
        parent = SpanContext(trace_id=int(record["traceId"], 16), span_id=int(record["parentSpanId"], 16), is_remote=True, trace_flags=TraceFlags(TraceFlags.SAMPLED))
        context = trace.set_span_in_context(NonRecordingSpan(parent))
    span = provider.get_tracer("hollow-purple").start_span(record["name"], context=context, start_time=int(record["startedAt"] * 1_000_000), attributes=record["attributes"])
    span.set_status(Status(StatusCode.ERROR if record["status"] == "error" else StatusCode.OK))
    span.end(end_time=int(record["endedAt"] * 1_000_000))
    flushed = provider.force_flush(timeout_millis=15000)
    provider.shutdown()
    if failed or not flushed:
        raise RuntimeError("Collector export was not confirmed")
    return {"status": "submitted", "traceId": record["traceId"], "spanId": record["spanId"]}


def main():
    record = json.loads(sys.stdin.read(256 * 1024))
    # SDK diagnostics stay private and never enter the controller's stdout.
    with contextlib.redirect_stdout(sys.stderr):
        result = export_span(record)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"status": "failed", "error": "Arize export failed; retained local evidence, no values substituted."}))
        sys.exit(1)
