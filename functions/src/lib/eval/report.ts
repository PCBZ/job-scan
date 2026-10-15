// The evaluation report job (#129): from a queued message naming a run's
// record, read it and the runs before it, work out the figures, and email
// them. Sending is the last step, so a failure before it never sends twice;
// a thrown error goes back to the queue, which retries it.

import type { Transporter } from "nodemailer";
import { z } from "zod";
import type { AppConfig } from "../config/load.js";
import { type EmailSettings, emailSettings } from "../delivery/email.js";
import type { RunRecordReader } from "../run/records.js";
import { evaluate } from "./evaluate.js";
import { renderHtml, renderText, subjectOf } from "./render.js";

/** The runs before this one that the trend shows. */
export const TREND_RUNS = 6;

export const evalMessage = z.object({
  record: z.string().min(1),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  startedAt: z.string().min(1),
});

export interface EvalReportDeps {
  env: Record<string, string | undefined>;
  config: () => Promise<AppConfig>;
  records: RunRecordReader;
  transport: (settings: EmailSettings) => Pick<Transporter, "sendMail">;
}

export interface EvalReportLog {
  log(message: string): void;
}

/**
 * Accepts the message as the queue trigger hands it over: parsed JSON, or
 * the JSON text when the runtime didn't parse it.
 */
export async function runEvalReport(
  message: unknown,
  d: EvalReportDeps,
  log: EvalReportLog,
): Promise<void> {
  const m = evalMessage.parse(typeof message === "string" ? JSON.parse(message) : message);
  const config = await d.config();
  const settings = emailSettings(config, d.env);
  if (!settings) {
    log.log(`evalReport: no report.email_account, so no evaluation email for ${m.record}`);
    return;
  }
  const evaluation = evaluate(
    await d.records.read(m.record),
    await d.records.earlier(m.record, TREND_RUNS),
  );
  await d.transport(settings).sendMail({
    from: settings.user,
    to: settings.to,
    subject: subjectOf(evaluation),
    html: renderHtml(evaluation),
    text: renderText(evaluation),
  });
  log.log(`evalReport: sent for ${m.record} (≈ $${evaluation.usd.toFixed(2)})`);
}
