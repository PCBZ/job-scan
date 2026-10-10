import { app, type InvocationContext, type Timer } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { composePipeline } from "../lib/run/compose.js";
import { runDaily } from "../lib/run/daily.js";

// The morning run (#22): every dependency from app settings, then the workflow.
// The managed identity signs every Azure call; secrets come from Key Vault
// references in the app settings.
export async function daily(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(`daily: triggered (past due: ${timer.isPastDue})`);
  await runDaily(composePipeline(process.env, new DefaultAzureCredential()), context);
}

app.timer("daily", {
  // NCRONTAB with seconds, in UTC: 15:00 UTC is 08:00 in Vancouver year-round,
  // since B.C. stays on UTC−7 from 2026 with no fall-back to PST.
  schedule: "0 0 15 * * *",
  handler: daily,
});
