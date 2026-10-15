// Registers OpenTelemetry before anything it traces loads (#101).
import "../telemetry.js";
import { app, type InvocationContext } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { blobConfigSource, loadConfig } from "../lib/config/load.js";
import { gmailTransport } from "../lib/delivery/email.js";
import { runEvalReport } from "../lib/eval/report.js";
import { runRecordReaderFromUrl } from "../lib/run/records.js";
import { loadSecrets, secretClientFromEnv } from "../lib/run/secrets.js";

// Each run's evaluation email (#127, #129), from the message the daily run
// queued (#128). The queue retries a failure, five times in all (host.json),
// then moves the message to eval-reports-poison.
export async function evalReport(message: unknown, context: InvocationContext): Promise<void> {
  const credential = new DefaultAzureCredential();
  const { env, missing } = await loadSecrets(
    process.env,
    secretClientFromEnv(process.env, credential),
  );
  if (missing.length) context.warn(`evalReport: not in Key Vault, so unset: ${missing.join(", ")}`);
  const setting = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`evalReport: ${key} is not set`);
    return value;
  };
  await runEvalReport(
    message,
    {
      env,
      config: () => loadConfig(blobConfigSource(setting("CONFIG_BLOB_URL"), credential)),
      records: runRecordReaderFromUrl(setting("RUN_RECORDS_URL"), credential),
      transport: gmailTransport,
    },
    context,
  );
}

app.storageQueue("evalReport", {
  queueName: "eval-reports",
  // EvalQueue__queueServiceUri, __credential and __clientId: the app's identity.
  connection: "EvalQueue",
  handler: evalReport,
});
