import { app, type InvocationContext, type Timer } from "@azure/functions";

// Placeholder for the morning run: fetch → extract → gate → score → deliver.
export async function daily(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(`daily: triggered (past due: ${timer.isPastDue})`);
}

app.timer("daily", {
  // NCRONTAB with seconds, in UTC: 15:00 UTC is 08:00 PDT. Fixed UTC, so it
  // runs at 07:00 once Vancouver falls back to PST.
  schedule: "0 0 15 * * *",
  handler: daily,
});
