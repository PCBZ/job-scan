// The run's side effects, the only ones it has. deliver publishes the report
// and sends it to every configured channel; mark_seen, reached only after a
// delivery, records what was read and recommended so tomorrow skips it.

import type { Transporter } from "nodemailer";
import type { AppConfig } from "../config/load.js";
import { runDay } from "../day.js";
import { emailReport, emailSettings, gmailTransport } from "../delivery/email.js";
import { telegramReport, telegramSettings } from "../delivery/telegram.js";
import type { SeenStore } from "../mail/seen-store.js";
import type { TableApplications } from "../postings/applications.js";
import type { TableSeenJobsStore } from "../postings/seen-jobs.js";
import { renderHtml } from "../report/html.js";
import type { ReportPublisher } from "../report/publish.js";
import type { Effects } from "../workflow/types.js";

type Env = Record<string, string | undefined>;

export interface EffectsServices {
  env: Env;
  publisher: ReportPublisher;
  seen: Pick<SeenStore, "markSeen">;
  seenJobs: Pick<TableSeenJobsStore, "recordRecommended">;
  applications: Pick<TableApplications, "addPending">;
  fetch: typeof fetch;
  /** Builds the SMTP transport; nodemailer's own in production. */
  transport?: (
    settings: NonNullable<ReturnType<typeof emailSettings>>,
  ) => Pick<Transporter, "sendMail">;
  now: () => Date;
}

export function productionEffects(d: EffectsServices): Effects {
  const transport = d.transport ?? gmailTransport;
  return {
    async deliver(report, config: AppConfig, signal) {
      // The browser copy first: both channels link to it.
      const url = await d.publisher.publish(renderHtml(report), report.day);
      // Try every channel, its settings included; a failure in one doesn't keep
      // the other from sending. Any failure fails the delivery, so mark_seen
      // won't run and tomorrow's run reports the same mail again.
      const failures: unknown[] = [];
      try {
        const email = emailSettings(config, d.env);
        if (email) await emailReport(transport(email), email, report, url);
      } catch (e) {
        failures.push(e);
      }
      try {
        const telegram = telegramSettings(config, d.env);
        if (telegram) await telegramReport(d.fetch, telegram, report, url, signal);
      } catch (e) {
        failures.push(e);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "deliver: every channel failed");
    },

    async markSeen({ mail, top }) {
      const day = runDay(d.now());
      await d.seen.markSeen(
        mail.messages.map((m) => ({ account: m.account, message_id: m.message_id })),
        day,
      );
      await d.seenJobs.recordRecommended(
        top.map((r) => r.posting),
        day,
      );
      await d.applications.addPending(top, day);
    },
  };
}
