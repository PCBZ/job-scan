import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import {
  EmailConfigError,
  emailReport,
  emailSettings,
  gmailTransport,
  subjectOf,
} from "../../src/lib/delivery/email.js";
import type { MailAccount } from "../../src/lib/mail/types.js";
import { NO_RESUMES } from "../../src/lib/report/source.js";
import type { Report, TopPick } from "../../src/lib/report/types.js";
import { SAMPLE } from "../report/sample.js";

const account = (name: string, host: string): MailAccount => ({
  name,
  host,
  port: 993,
  folder: "INBOX",
  senders: [],
  subjectKeywords: [],
  excludeSenders: [],
  maxMessages: 50,
  maxCharsPerMessage: 8000,
  userEnv: `${name.toUpperCase()}_USER`,
  passwordEnv: `${name.toUpperCase()}_PASSWORD`,
});

const config = (report: AppConfig["report"]) =>
  ({
    mail: {
      accounts: [account("personal", "imap.gmail.com"), account("school", "outlook.office365.com")],
      maxTotalMessages: 100,
      days: 7,
    },
    report,
    profile: {},
    resume: {},
  }) as unknown as AppConfig;

const ENV = { PERSONAL_USER: "me@example.test", PERSONAL_PASSWORD: "test-password-a" };

describe("emailSettings", () => {
  it("sends nothing when no account is named", () => {
    expect(emailSettings(config({}), ENV)).toBeNull();
  });

  it("uses the named Gmail account's credentials, and mails that account by default", () => {
    expect(emailSettings(config({ email_account: "personal" }), ENV)).toEqual({
      user: "me@example.test",
      password: "test-password-a",
      to: "me@example.test",
    });
    expect(
      emailSettings(config({ email_account: "personal", email_to: "other@example.test" }), ENV)?.to,
    ).toBe("other@example.test");
  });

  it.each([
    [
      { email_account: "nobody" },
      ENV,
      'report.email_account "nobody" is not one of the [[account]] names',
    ],
    [{ email_account: "school" }, ENV, "must be a Gmail account"],
    [
      { email_account: "personal" },
      { PERSONAL_USER: "me@example.test" },
      "PERSONAL_USER and PERSONAL_PASSWORD must be set",
    ],
    [
      { email_account: "personal" },
      { ...ENV, PERSONAL_PASSWORD: "  " },
      "PERSONAL_USER and PERSONAL_PASSWORD must be set",
    ],
  ])("rejects %j", (report, env, message) => {
    expect(() => emailSettings(config(report), env)).toThrow(EmailConfigError);
    expect(() => emailSettings(config(report), env)).toThrow(message);
  });
});

describe("subjectOf", () => {
  const r = (over: Partial<Report>) => ({ ...SAMPLE, ...over });
  it.each([
    [r({ alerts: [] }), "Job Scan — 2026-10-08: 2 worth your time"],
    [r({}), "Job Scan — 2026-10-08: 2 worth your time (1 mailbox failed)"],
    [
      r({ alerts: ["a", "b"], top: [] }),
      "Job Scan — 2026-10-08: 0 worth your time (2 mailboxes failed)",
    ],
    [r({ outcome: "no_mail", alerts: [] }), "Job Scan — 2026-10-08: no new mail"],
    [
      r({ outcome: "no_resumes", top: [], alerts: [NO_RESUMES, "a"] }),
      "Job Scan — 2026-10-08: no resumes, nothing scored (1 mailbox failed)",
    ],
    [
      r({ funnel: "Every mailbox failed to sync, so nothing was scanned today." }),
      "Job Scan — 2026-10-08: every mailbox failed",
    ],
  ])("%#: %s", (report, subject) => {
    expect(subjectOf(report)).toBe(subject);
  });

  it("never carries a posting's own words", () => {
    const hostile = { ...(SAMPLE.top[0] as TopPick), title: "WIN\r\nBcc: attacker@example.test" };
    expect(subjectOf({ ...SAMPLE, top: [hostile] })).not.toContain("attacker");
  });
});

describe("emailReport", () => {
  /** nodemailer's own stream transport: builds the real message, sends nothing. */
  function capture() {
    const sent: string[] = [];
    const messages: { html?: unknown; text?: unknown }[] = [];
    const stream = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "unix",
    });
    const transport = {
      sendMail: async (message: Parameters<typeof stream.sendMail>[0]) => {
        messages.push(message);
        const info = await stream.sendMail(message);
        sent.push(String(info.message));
        return info;
      },
    };
    return { transport: transport as unknown as Pick<typeof stream, "sendMail">, sent, messages };
  }
  const settings = { user: "me@example.test", password: "test-password-a", to: "me@example.test" };

  it("sends the HTML report and a plain-text part, from and to the configured addresses", async () => {
    const { transport, sent } = capture();
    await emailReport(
      transport,
      settings,
      SAMPLE,
      "https://acct.blob.core.windows.net/reports/2026-10-08.html?sig=x",
    );
    const raw = sent[0] ?? "";
    expect(raw).toMatch(/^From: me@example\.test$/m);
    expect(raw).toMatch(/^To: me@example\.test$/m);
    expect(raw).toContain("Subject: =?UTF-8?Q?Job_Scan_=E2=80=94_2026-10-08");
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("Content-Type: text/html; charset=utf-8");
    expect(raw).not.toMatch(/Content-Disposition: attachment/i);
    expect(raw).toContain("View in a browser");
  });

  it("puts the browser link in both parts", async () => {
    const { transport, messages } = capture();
    await emailReport(transport, settings, SAMPLE, "https://reports.example/x");
    expect(String(messages[0]?.html)).toContain(">View in a browser</a>");
    expect(String(messages[0]?.text)).toContain("View in a browser: https://reports.example/x");
  });

  it("sends without a browser link when there is none", async () => {
    const { transport, sent } = capture();
    await emailReport(transport, settings, SAMPLE);
    expect(sent[0]).not.toContain("View in a browser");
  });
});

describe("gmailTransport", () => {
  it("talks to smtp.gmail.com over TLS on 465", () => {
    const t = gmailTransport({
      user: "me@example.test",
      password: "test-password-a",
      to: "me@example.test",
    });
    expect(t.options).toMatchObject({ host: "smtp.gmail.com", port: 465, secure: true });
  });
});
