import "../config.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Sends one span to Arize AX and reports whether it was accepted.
 *
 *   pnpm --filter @hollow-purple/server exec node --import tsx src/scripts/verify-arize.ts
 */

const space = process.env.ARIZE_SPACE_ID;
const key = process.env.ARIZE_API_KEY;
if (!space || !key) throw new Error("Set ARIZE_SPACE_ID and ARIZE_API_KEY in .env first.");
const project = process.env.ARIZE_PROJECT_NAME || "antibody";
const url = process.env.ARIZE_OTLP_URL || "https://otlp.arize.com/v1/traces";

const otlp = new OTLPTraceExporter({ url, headers: { space_id: space, api_key: key } });
let outcome: { code: number; error?: Error } | undefined;
const probe: SpanExporter = {
  export: (spans, done) => otlp.export(spans, (result) => { outcome = result; done(result); }),
  shutdown: () => otlp.shutdown(),
};
const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "antibody-lab", "openinference.project.name": project, model_id: project }),
  spanProcessors: [new SimpleSpanProcessor(probe)],
});
const span = provider.getTracer("antibody-lab").startSpan("arize connectivity check", {
  attributes: { "openinference.span.kind": "CHAIN", "input.value": "ping", "output.value": "pong" },
});
span.end();
await provider.forceFlush();
await provider.shutdown();
if (outcome?.code === 0) console.log(`Arize accepted the span (project "${project}").`);
else {
  console.error(`Arize export failed: ${outcome?.error?.message ?? "no result"}`);
  process.exitCode = 1;
}
