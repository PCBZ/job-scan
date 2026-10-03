import { app, type InvocationContext, type Timer } from "@azure/functions";

// Placeholder for the morning run: fetch → extract → gate → score → deliver.
export async function daily(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(`daily: triggered (past due: ${timer.isPastDue})`);
}

app.timer("daily", {
  // NCRONTAB with seconds, in UTC: 14:00 UTC is 07:00 in Vancouver (PDT).
  schedule: "0 0 14 * * *",
  handler: daily,
});
