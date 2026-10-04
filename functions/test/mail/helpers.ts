import type { Mailbox, SearchQuery } from "../../src/lib/mail/mailbox.js";
import type { MailAccount } from "../../src/lib/mail/types.js";

export function account(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    name: "gmail-main",
    host: "imap.gmail.com",
    port: 993,
    folder: "INBOX",
    senders: ["linkedin.com", "indeed.com"],
    subjectKeywords: [],
    excludeSenders: [],
    maxMessages: 60,
    maxCharsPerMessage: 6000,
    userEnv: "GMAIL_MAIN_USER",
    passwordEnv: "GMAIL_MAIN_PASSWORD",
    ...overrides,
  };
}

interface EmlOptions {
  from?: string;
  subject?: string;
  messageId?: string | null;
  date?: string | null;
  plain?: string;
  html?: string;
}

/** A minimal RFC 822 message; multipart/alternative when both bodies are given. */
export function eml(o: EmlOptions = {}): Uint8Array {
  const head = [
    `From: ${o.from ?? "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>"}`,
    `Subject: ${o.subject ?? "New jobs for you"}`,
    ...(o.messageId === null ? [] : [`Message-ID: ${o.messageId ?? "<m1@example.com>"}`]),
    ...(o.date === null ? [] : [`Date: ${o.date ?? "Sat, 03 Oct 2026 08:15:00 -0700"}`]),
    "MIME-Version: 1.0",
  ];
  let body: string[];
  if (o.plain !== undefined && o.html !== undefined) {
    body = [
      'Content-Type: multipart/alternative; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain; charset=utf-8",
      "",
      o.plain,
      "--B",
      "Content-Type: text/html; charset=utf-8",
      "",
      o.html,
      "--B--",
    ];
  } else if (o.html !== undefined) {
    body = ["Content-Type: text/html; charset=utf-8", "", o.html];
  } else {
    body = ["Content-Type: text/plain; charset=utf-8", "", o.plain ?? ""];
  }
  return new TextEncoder().encode([...head, ...body, ""].join("\r\n"));
}

export const LONG_PLAIN = `Senior Backend Engineer\nNorthwind Traders\nVancouver, BC\n${"Build and run distributed services. ".repeat(8)}`;

/** A Mailbox fake that records what the fetch asked for. */
export class FakeMailbox implements Mailbox {
  opened: string[] = [];
  searches: SearchQuery[] = [];
  fetched: number[] = [];
  closed = false;

  constructor(
    private readonly messages: Map<number, Uint8Array | null>,
    private readonly searchError: ((q: SearchQuery) => Error | null) | null = null,
  ) {}

  async open(folder: string) {
    this.opened.push(folder);
  }

  async search(query: SearchQuery) {
    this.searches.push(query);
    const err = this.searchError?.(query);
    if (err) throw err;
    return [...this.messages.keys()].sort((a, b) => a - b);
  }

  async fetchSource(uid: number) {
    this.fetched.push(uid);
    return this.messages.get(uid) ?? null;
  }

  async close() {
    this.closed = true;
  }
}
