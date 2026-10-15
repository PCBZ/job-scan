// OpenTelemetry for the worker (#101), imported first by every function so it
// is registered before the code it traces loads. host.json's telemetryMode
// sends the host's telemetry the same way, so one trace holds both.
//
// Exports to APPLICATIONINSIGHTS_CONNECTION_STRING, which Terraform sets. The
// tracer is registered either way, so every run has a real trace id for its
// evaluation report (#128); with no connection string, spans go nowhere.
// No auto-instrumentation: model calls come from OpenInference, patched
// directly (lib/telemetry/instrument.ts), and graph nodes from the builder.
// https://learn.microsoft.com/azure/azure-functions/opentelemetry-howto

import * as azFunc from "@azure/functions";
import { AzureFunctionsInstrumentationESM } from "@azure/functions-opentelemetry-instrumentation";
import {
  AzureMonitorLogExporter,
  AzureMonitorTraceExporter,
} from "@azure/monitor-opentelemetry-exporter";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { instrumentOpenAI } from "./lib/telemetry/instrument.js";

const exporting = Boolean(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
const tracerProvider = new NodeTracerProvider({
  spanProcessors: exporting ? [new SimpleSpanProcessor(new AzureMonitorTraceExporter())] : [],
});
tracerProvider.register();

if (exporting) {
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: new AzureMonitorLogExporter() })],
  });

  // The app is ESM, so the require hook that would patch @azure/functions
  // never fires: register it by hand. That binds each handler to the host's
  // invocation trace, sends context.log through the log exporter, and tells
  // the host the worker exports its own logs, so they aren't sent twice.
  const functions = new AzureFunctionsInstrumentationESM();
  registerInstrumentations({ tracerProvider, loggerProvider, instrumentations: [functions] });
  functions.registerAzFunc(azFunc);
  instrumentOpenAI(tracerProvider);
}
