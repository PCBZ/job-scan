// Email the full report through Gmail SMTP (#2, #20): from one configured
// Gmail account, reusing its IMAP app password, to a recipient taken only
// from config. The body is the HTML report plus a plain-text part; nothing
// from the inbox is attached, and no mail-derived text goes in a header.

import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "../config/load.js";
import { appError } from "../errors.js";
import type { Evaluation } from "../eval/evaluate.js";
import { renderHtml as renderEvaluationHtml, usd } from "../eval/html.js";
import { renderText as renderEvaluationText } from "../eval/text.js";
import { renderHtml } from "../report/html.js";
import { NO_RESUMES } from "../report/source.js";
import { renderText } from "../report/text.js";
import type { Report } from "../report/types.js";

type Env = Record<string, string | undefined>;

/**
 * Gmail's SMTP server, over SSL on 465 with the account's app password:
 * https://support.google.com/a/answer/176600. Azure blocks outbound 25, not 465.
 */
const GMAIL_SMTP = { host: "smtp.gmail.com", port: 465, secure: true } as const;

export interface EmailSettings {
  user: string;
  password: string;
  to: string;
}

/** Null when the config sends no email; an error when it's set up wrong. */
export function emailSettings(config: AppConfig, env: Env): EmailSettings | null {
  const name = config.report.email_account;
  if (!name) return null;
  const account = config.mail.accounts.find((a) => a.name === name);
  if (!account) {
    throw appError("config", `report.email_account "${name}" is not one of the [[account]] names`);
  }
  if (account.host !== "imap.gmail.com") {
    throw appError(
      "config",
      `report.email_account "${name}" must be a Gmail account, to send through Gmail SMTP`,
    );
  }
  const user = env[account.userEnv]?.trim();
  const password = env[account.passwordEnv]?.trim();
  if (!user || !password) {
    throw appError(
      "config",
      `${account.userEnv} and ${account.passwordEnv} must be set to send the report`,
    );
  }
  return { user, password, to: config.report.email_to ?? user };
}

/** Counts only: the subject never carries a posting's own words. */
export function subjectOf(r: Report): string {
  if (r.funnel.startsWith("Every mailbox failed"))
    return `Job Scan — ${r.day}: every mailbox failed`;
  const head =
    r.outcome === "no_mail"
      ? "no new mail"
      : r.outcome === "no_resumes"
        ? "no resumes, nothing scored"
        : `${r.top.length} worth your time`;
  const mailboxes = r.alerts.filter((a) => a !== NO_RESUMES).length;
  const failed = mailboxes ? ` (${mailboxes} mailbox${mailboxes === 1 ? "" : "es"} failed)` : "";
  return `Job Scan — ${r.day}: ${head}${failed}`;
}

export function gmailTransport(s: EmailSettings): Transporter {
  return nodemailer.createTransport({
    ...GMAIL_SMTP,
    auth: { user: s.user, pass: s.password },
  });
}

/** Send the report; `webUrl` is its SAS link (#19), shown as "View in a browser". */
export async function emailReport(
  transport: Pick<Transporter, "sendMail">,
  s: EmailSettings,
  report: Report,
  webUrl?: string,
): Promise<void> {
  await transport.sendMail({
    from: s.user,
    to: s.to,
    subject: subjectOf(report),
    html: renderHtml(report, webUrl),
    text: renderText(report, webUrl),
  });
}

/** The evaluation email's subject (#129): numbers only, never a posting's words. */
export function evaluationSubject(e: Evaluation): string {
  return `Job Scan — evaluation ${e.day} (${e.version}): ≈ ${usd(e.usd)}`;
}

/**
 * Send a run's evaluation (#129) to the daily report's recipient, and return
 * the subject; `subjectPrefix` marks a smoke test's copy (#134).
 */
export async function emailEvaluation(
  transport: Pick<Transporter, "sendMail">,
  s: EmailSettings,
  evaluation: Evaluation,
  subjectPrefix = "",
): Promise<string> {
  const subject = `${subjectPrefix}${evaluationSubject(evaluation)}`;
  await transport.sendMail({
    from: s.user,
    to: s.to,
    subject,
    html: renderEvaluationHtml(evaluation),
    text: renderEvaluationText(evaluation),
  });
  return subject;
}
