// OpenTelemetry for the worker (#101), imported first by every function so it
// is registered before the code it traces loads. host.json's telemetryMode
// sends the host's telemetry the same way, so one trace holds both.
//
// Exports to APPLICATIONINSIGHTS_CONNECTION_STRING, which Terraform sets; with
// none (tests, local runs) nothing is registered and spans are no-ops.
// No auto-instrumentation: model calls come from OpenInference, patched
// directly (lib/telemetry/instrument.ts), and graph nodes from the builder.
// https://learn.microsoft.com/azure/azure-functions/opentelemetry-howto

import { AzureFunctionsInstrumentation } from "@azure/functions-opentelemetry-instrumentation";
import {
  AzureMonitorLogExporter,
  AzureMonitorTraceExporter,
} from "@azure/monitor-opentelemetry-exporter";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { instrumentOpenAI } from "./lib/telemetry/instrument.js";

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new AzureMonitorTraceExporter())],
  });
  tracerProvider.register();

  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: new AzureMonitorLogExporter() })],
  });

  registerInstrumentations({
    tracerProvider,
    loggerProvider,
    instrumentations: [new AzureFunctionsInstrumentation()],
  });
  instrumentOpenAI(tracerProvider);
}
