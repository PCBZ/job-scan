// One raw message → a kept message, or the reason it was dropped. Mirrors the
// per-message loop in scripts/fetch_mail.py.

import PostalMime, { decodeWords, type Email } from "postal-mime";
import { cleanText, extractLinks, htmlToText } from "../mail-text.js";
import { codePointLength, stripWhitespace } from "../unicode.js";
import type { FetchedMessage, MailAccount } from "./types.js";

// postal-mime fills a part's missing plain or html from the other type, so a
// short plain intro next to a long HTML posting reads as a long plain body.
// scripts/mail_text.message_body takes each type from its own parts only, so
// this parser does too. It overrides postal-mime internals (pinned at 4.0.4);
// the mixed-part test in message.test.ts fails if an upgrade changes them.
type TextEntry = { type: "text"; value: string } | { type: "subMessage"; value: Email };
interface ParserInternals {
  textMap: Map<unknown, Partial<Record<"plain" | "html", TextEntry[]>>>;
  textTypes: Set<"plain" | "html">;
  textContent: Record<string, string>;
}

class OwnPartsParser extends PostalMime {
  renderTextContent(): void {
    const self = this as unknown as ParserInternals;
    const out: Record<string, string[]> = {};
    self.textMap.forEach((entry) => {
      for (const type of self.textTypes) {
        out[type] ??= [];
        for (const item of entry[type] ?? []) {
          const sub = type === "html" ? (item.value as Email).html : (item.value as Email).text;
          out[type].push(item.type === "text" ? item.value : (sub ?? ""));
        }
      }
    });
    for (const [type, parts] of Object.entries(out)) self.textContent[type] = parts.join("\n");
  }
}

export type MessageOutcome =
  | { kind: "kept"; message: FetchedMessage }
  | { kind: "seen" }
  | { kind: "filtered" };

/** The Message-ID header, or a stable stand-in when a sender omits it. */
export function messageIdOf(headers: { key: string; value: string }[]): string {
  const raw = (key: string) => headers.find((h) => h.key === key)?.value ?? "";
  const id = stripWhitespace(raw("message-id"));
  return id || `no-id:${raw("date")}:${raw("subject")}`;
}

export async function processMessage(
  source: Uint8Array,
  account: MailAccount,
  seenIds: ReadonlySet<string>,
): Promise<MessageOutcome> {
  const email = await new OwnPartsParser().parse(source);
  const header = (key: string) => email.headers.find((h) => h.key === key)?.value ?? "";

  // Namespaced by account upstream: one alert in two mailboxes is two messages.
  const messageId = messageIdOf(email.headers);
  if (seenIds.has(messageId)) return { kind: "seen" };

  const sender = decodeWords(header("from"));
  const subject = decodeWords(header("subject"));
  const lowSender = sender.toLowerCase();
  const lowSubject = subject.toLowerCase();

  if (account.excludeSenders.some((b) => lowSender.includes(b.toLowerCase()))) {
    return { kind: "filtered" };
  }
  // The keyword filter only applies to senders not on the allowlist.
  const keywords = account.subjectKeywords.map((k) => k.toLowerCase());
  const allowlisted = account.senders.some((s) => lowSender.includes(s.toLowerCase()));
  if (keywords.length > 0 && !allowlisted && !keywords.some((k) => lowSubject.includes(k))) {
    return { kind: "filtered" };
  }

  const plain = email.text ?? "";
  const html = email.html ?? "";
  // Which path runs depends on who mails you, so record it rather than assume.
  const usePlain = codePointLength(stripWhitespace(plain)) > 200;
  const body = cleanText(usePlain ? plain : htmlToText(html || plain), account.maxCharsPerMessage);
  if (codePointLength(body) < 40) return { kind: "filtered" };

  const parsedDate = email.date ? new Date(email.date) : null;
  const date = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : "";

  return {
    kind: "kept",
    message: {
      account: account.name,
      message_id: messageId,
      from: sender,
      subject,
      date,
      body,
      body_source: usePlain ? "plain" : "html",
      links: html ? extractLinks(html) : [],
    },
  };
}
