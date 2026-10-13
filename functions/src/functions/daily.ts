// Registers OpenTelemetry before anything it traces loads (#101).
import "../telemetry.js";
import { app, type InvocationContext, type Timer } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { composePipeline } from "../lib/run/compose.js";
import { runDaily } from "../lib/run/daily.js";
import { loadSecrets, secretClientFromEnv } from "../lib/run/secrets.js";

// The morning run (#22): secrets from Key Vault, every dependency from app
// settings, then the workflow. The app's user-assigned identity (AZURE_CLIENT_ID)
// signs every Azure call.
export async function daily(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(`daily: triggered (past due: ${timer.isPastDue})`);
  const credential = new DefaultAzureCredential();
  const { env, missing } = await loadSecrets(
    process.env,
    secretClientFromEnv(process.env, credential),
  );
  if (missing.length) context.warn(`daily: not in Key Vault, so unset: ${missing.join(", ")}`);
  await runDaily(composePipeline(env, credential), context);
}

app.timer("daily", {
  // NCRONTAB with seconds, in UTC: 15:00 UTC is 08:00 in Vancouver year-round,
  // since B.C. stays on UTC−7 from 2026 with no fall-back to PST.
  schedule: "0 0 15 * * *",
  handler: daily,
});
