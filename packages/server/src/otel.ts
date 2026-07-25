// OpenTelemetry initialization — MUST be loaded before any other module.
// Bun --preload ./src/otel.ts ensures this runs first so auto-instrumentation
// wraps every HTTP, fetch, and database call from the start.
//
// Trace export: OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (default localhost:4318).
// Logs + metrics: auto-detected by the SDK from OTEL_METRICS_EXPORTER,
// OTEL_LOGS_EXPORTER, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, etc.
// The engine/telemetry.ts counters/gauges and the structured refusal logs
// route through the global providers and auto-export when configured.
//
// SigNoz dashboard labels: service.name = "glasspay-server"

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

// Enable diagnostic logging when GLASSPAY_OTEL_DEBUG=1
if (process.env.GLASSPAY_OTEL_DEBUG === "1") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

const sdk = new NodeSDK({
  serviceName: "glasspay-server",
  traceExporter: new OTLPTraceExporter({
    url: `${otelEndpoint}/v1/traces`,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy diagnostics: we add our own fine-grained spans
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

// Graceful shutdown on SIGTERM (Railway sends this)
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => console.log("[otel] SDK shut down"))
    .catch((err) => console.error("[otel] shutdown error", err))
    .finally(() => process.exit(0));
});

// Bun --preload requires a default export or top-level await to block
// until the SDK is ready.
try {
  await sdk.start();
  console.log("[otel] OpenTelemetry SDK started — exporting to", otelEndpoint);
} catch (err) {
  console.error("[otel] failed to start SDK", err);
}

export { sdk };
export { trace, context, SpanStatusCode } from "@opentelemetry/api";
export { logs, SeverityNumber } from "@opentelemetry/api-logs";
export type { Counter, UpDownCounter, Histogram } from "@opentelemetry/api";
