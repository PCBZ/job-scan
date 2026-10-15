// Registers OpenTelemetry before anything it traces loads (#101).
import "../telemetry.js";
import { app, type InvocationContext } from "@azure/functions";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { z } from "zod";
import { blobConfigSource, loadConfig } from "../lib/config/load.js";
import { gmailTransport } from "../lib/delivery/email.js";
import { latencyFromWorkspace } from "../lib/eval/latency.js";
import { type EvalReportDeps, runEvalReport } from "../lib/eval/report.js";
import { evalQueueFromUrl } from "../lib/run/eval-queue.js";
import { runRecordReaderFromUrl } from "../lib/run/records.js";
import { loadSecrets, secretClientFromEnv } from "../lib/run/secrets.js";

type Env = Record<string, string | undefined>;

/** The app settings this function needs; parsing names every one missing. */
const settingsSchema = z.object({
  CONFIG_BLOB_URL: z.url(),
  RUN_RECORDS_URL: z.url(),
  EVAL_QUEUE_URL: z.url(),
  LOG_ANALYTICS_WORKSPACE_ID: z.uuid(),
});

/** Its dependencies in Azure, from app settings and the app's identity. */
export function productionDeps(env: Env, credential: TokenCredential): EvalReportDeps {
  const settings = settingsSchema.parse(env);
  return {
    env,
    config: () => loadConfig(blobConfigSource(settings.CONFIG_BLOB_URL, credential)),
    records: runRecordReaderFromUrl(settings.RUN_RECORDS_URL, credential),
    transport: gmailTransport,
    latency: latencyFromWorkspace(settings.LOG_ANALYTICS_WORKSPACE_ID, credential),
    requeue: (message, delaySeconds) =>
      evalQueueFromUrl(settings.EVAL_QUEUE_URL, credential).send(message, delaySeconds),
  };
}

/**
 * Each run's evaluation email (#127, #129), from the message the daily run
 * queued (#128). The queue retries a failure, five times in all (host.json),
 * then moves the message to eval-reports-poison. Dependencies and the
 * credential are parameters, so a test can pass its own.
 */
export function evalReportHandler(make = productionDeps) {
  return async (
    queueEntry: unknown,
    context: InvocationContext,
    credential: TokenCredential = new DefaultAzureCredential(),
  ): Promise<void> => {
    const { env, missing } = await loadSecrets(
      process.env,
      secretClientFromEnv(process.env, credential),
    );
    if (missing.length)
      context.warn(`evalReport: not in Key Vault, so unset: ${missing.join(", ")}`);
    await runEvalReport(queueEntry, make(env, credential), context);
  };
}

app.storageQueue("evalReport", {
  queueName: "eval-reports",
  // EvalQueue__queueServiceUri, __credential and __clientId: the app's identity.
  connection: "EvalQueue",
  handler: evalReportHandler(),
});
