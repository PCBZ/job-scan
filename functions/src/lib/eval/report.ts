// The evaluation report job (#129): from a queued message naming a run's
// record, read it and the runs before it, work out the figures, and email
// them. Sending is the last step, so a failure before it never sends twice;
// a thrown error goes back to the queue, which retries it.
//
// It waits for all its data (#130): until the run's trace is in Application
// Insights, the message goes back on the queue, a few times, before the email
// goes out without the latency. A mark beside the run record lets only one
// message per run send, whatever the queue redelivers.

import type { Transporter } from "nodemailer";
import { z } from "zod";
import type { AppConfig } from "../config/load.js";
import { type EmailSettings, emailEvaluation, emailSettings } from "../delivery/email.js";
import type { EvalMessage } from "../run/eval-queue.js";
import type { RunRecordReader, RunStatsRecord, SentMarks } from "../run/records.js";
import { evaluate } from "./evaluate.js";
import type { Latency, LatencySource } from "./latency.js";
import { JEV_NODES } from "./prices.js";

/** The runs before this one that the trend shows. */
export const TREND_RUNS = 6;

/** How often the report waits for the run's trace, and how long each time. */
export const LATENCY_WAITS = 5;
export const LATENCY_WAIT_SECONDS = 10 * 60;

export const evalMessage = z.object({
  record: z.string().min(1),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  startedAt: z.string().min(1),
  /** Times the report has already waited for the trace (#130). */
  waited: z.number().int().nonnegative().default(0),
});

export interface EvalReportDeps {
  env: Record<string, string | undefined>;
  config: () => Promise<AppConfig>;
  records: RunRecordReader;
  transport: (settings: EmailSettings) => Pick<Transporter, "sendMail">;
  latency: LatencySource;
  /** Puts the message back on the queue, hidden for `delaySeconds`. */
  requeue: (message: EvalMessage, delaySeconds: number) => Promise<void>;
  sent: SentMarks;
}

export interface EvalReportLog {
  log(message: string): void;
}

/**
 * The queue entry is `unknown`, as the Functions SDK types it: parsed JSON,
 * or the JSON text when the runtime didn't parse it. The schema checks it.
 */
export async function runEvalReport(
  queueEntry: unknown,
  d: EvalReportDeps,
  log: EvalReportLog,
): Promise<void> {
  const m = evalMessage.parse(typeof queueEntry === "string" ? JSON.parse(queueEntry) : queueEntry);
  const config = await d.config();
  const settings = emailSettings(config, d.env);
  if (!settings) {
    log.log(`evalReport: no report.email_account, so no evaluation email for ${m.record}`);
    return;
  }
  const records = await d.records.read(m.record);
  // The run made model calls if an Azure node used tokens: then its trace
  // isn't complete without them.
  const run = records.find((r): r is RunStatsRecord => r.kind === "run");
  const expectCalls = Object.entries(run?.usage ?? {}).some(
    ([node, u]) => !JEV_NODES.has(node) && u.input > 0,
  );
  let latency: Latency | null = null;
  let why = "not in Application Insights yet";
  try {
    latency = await d.latency(m.traceId, new Date(m.startedAt), expectCalls);
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (latency === null && m.waited < LATENCY_WAITS) {
    await d.requeue({ ...m, waited: m.waited + 1 }, LATENCY_WAIT_SECONDS);
    log.log(
      `evalReport: the run's latency is ${why}; waiting for ${m.record} (${m.waited + 1}/${LATENCY_WAITS})`,
    );
    return;
  }
  const evaluation = evaluate(records, await d.records.earlier(m.record, TREND_RUNS), latency);
  // At most one email per run: a second message for it stops here.
  if (!(await d.sent.claim(m.record))) {
    log.log(`evalReport: ${m.record} already has its evaluation email`);
    return;
  }
  try {
    await emailEvaluation(d.transport(settings), settings, evaluation);
  } catch (err) {
    await d.sent.release(m.record);
    throw err;
  }
  log.log(`evalReport: sent for ${m.record} (≈ $${evaluation.usd.toFixed(2)})`);
}
