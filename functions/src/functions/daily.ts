// Registers OpenTelemetry before anything it traces loads (#101).
import "../telemetry.js";
import { app, type InvocationContext, type Timer } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { runDay } from "../lib/day.js";
import { marketClosed } from "../lib/market-days.js";
import { composePipeline } from "../lib/run/compose.js";
import { runIngest } from "../lib/run/ingest.js";
import { loadSecrets, secretClientFromEnv } from "../lib/run/secrets.js";

// The morning run (#22): secrets from Key Vault, every dependency from app
// settings, then the mail source's workflow, which hands its postings to collect. The app's user-assigned identity (AZURE_CLIENT_ID)
// signs every Azure call. Only on the US stock market's trading days (#212):
// on any other day it stops before reading anything.
export async function daily(
  timer: Timer,
  context: InvocationContext,
  now: () => Date = () => new Date(),
): Promise<void> {
  const closed = marketClosed(runDay(now()));
  if (closed) {
    context.log(`daily: skipped: market closed (${closed})`);
    return;
  }
  context.log(`daily: triggered (past due: ${timer.isPastDue})`);
  const credential = new DefaultAzureCredential();
  const { env, missing } = await loadSecrets(
    process.env,
    secretClientFromEnv(process.env, credential),
  );
  if (missing.length) context.warn(`daily: not in Key Vault, so unset: ${missing.join(", ")}`);
  await runIngest(composePipeline(env, credential), context);
}

app.timer("daily", {
  // NCRONTAB with seconds, in UTC: 15:00 UTC is 08:00 in Vancouver year-round,
  // since B.C. stays on UTC−7 from 2026 with no fall-back to PST. Weekdays only;
  // the handler skips market holidays, which NCRONTAB can't express.
  schedule: "0 0 15 * * 1-5",
  handler: daily,
});
