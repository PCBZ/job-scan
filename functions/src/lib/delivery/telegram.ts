// The daily Telegram summary (#21): the top picks in a few lines each, with
// Approve / Skip buttons and a link to the full report. Sent with one Bot API
// call; the buttons' callbacks are handled by the webhook (#24).

import { createHash } from "node:crypto";
import type { AppConfig } from "../config/load.js";
import { fingerprint } from "../fingerprint.js";
import type { Report, TopPick } from "../report/types.js";

type Env = Record<string, string | undefined>;

/** The Bot API endpoint: https://core.telegram.org/bots/api#making-requests */
const TELEGRAM_API = "https://api.telegram.org";

/**
 * A message's text is "1-4096 characters after entities parsing":
 * https://core.telegram.org/bots/api#sendmessage. We count the HTML tags too,
 * so the check is stricter than Telegram's.
 */
const MAX_TEXT = 4096;

export class TelegramConfigError extends Error {
  override name = "TelegramConfigError";
}

export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(
    message: string,
    readonly status: number,
    /** Seconds to wait, when Telegram rate-limits the bot. */
    readonly retryAfter: number | undefined,
  ) {
    super(message);
  }
}

export interface TelegramSettings {
  token: string;
  chatId: string;
}

/** Null when the config sends no Telegram message; an error when half set up. */
export function telegramSettings(config: AppConfig, env: Env): TelegramSettings | null {
  const chat = config.report.telegram_chat_id;
  if (chat === undefined) return null;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new TelegramConfigError("TELEGRAM_BOT_TOKEN must be set to send the summary");
  return { token, chatId: String(chat) };
}

/**
 * A posting's key in button callbacks: 16 hex characters of the SHA-256 of
 * its fingerprint, so "a:<fp16>" stays far under callback_data's "1-64 bytes":
 * https://core.telegram.org/bots/api#inlinekeyboardbutton
 */
export const fp16 = (p: Pick<TopPick, "company" | "title">) =>
  createHash("sha256").update(fingerprint(p)).digest("hex").slice(0, 16);

/** One mailbox alert, before escaping: its error detail can be long. */
const ALERT_MAX = 300;
/** Room kept after the header for the closing line. */
const TAIL_ROOM = 100;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** HTML mode needs only <, > and & escaped: https://core.telegram.org/bots/api#html-style */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function pickLines(p: TopPick, n: number): string {
  const send = p.either ? `${p.variant} or ${p.either}` : p.variant;
  const score = `${p.score}/100${p.confidence === "high" ? "" : ` (${p.confidence})`}`;
  const where = [p.location, p.salary].filter(Boolean).join(" · ");
  const gap = p.gap?.requirement ? `\n   Gap: ${esc(p.gap.requirement)}` : "";
  return `${n}. <b>${esc(p.title)}</b> — ${esc(p.company)}\n   ${score}${where ? ` · ${esc(where)}` : ""} · send ${esc(send)}${gap}`;
}

type Button = { text: string; callback_data: string } | { text: string; url: string };

export interface TelegramMessage {
  text: string;
  buttons: Button[][];
}

export function telegramMessage(r: Report, webUrl?: string): TelegramMessage {
  // Lengths are bounded on plain text, before any markup is added, so the
  // message never needs a raw cut that could split a tag or an entity.
  const alerts = r.alerts.map((a) => `⚠️ ${esc(clip(a, ALERT_MAX))}`);
  const headFor = (k: number) =>
    [
      `<b>Job Scan — ${esc(r.day)}</b>`,
      ...alerts.slice(0, k),
      ...(k < alerts.length ? [`⚠️ …and ${alerts.length - k} more alerts in the full report.`] : []),
      esc(r.funnel),
    ].join("\n");
  // Leave room after the header for the empty-day or "…and N more" line.
  let k = alerts.length;
  while (k > 0 && headFor(k).length > MAX_TEXT - TAIL_ROOM) k--;
  const head = headFor(k);
  const empty = r.top.length === 0 ? "\n\nNothing cleared the floor today." : "";

  // Drop picks from the end until the text fits, and say so.
  let shown = r.top.length;
  const textFor = (k: number) => {
    const picks = r.top.slice(0, k).map((p, i) => pickLines(p, i + 1));
    const more = k < r.top.length ? `\n\n…and ${r.top.length - k} more in the full report.` : "";
    return `${head}${empty}${picks.length ? `\n\n${picks.join("\n\n")}` : ""}${more}`;
  };
  while (shown > 0 && textFor(shown).length > MAX_TEXT) shown--;

  const buttons: Button[][] = r.top.slice(0, shown).map((p, i) => [
    { text: `✅ Approve ${i + 1}`, callback_data: `a:${fp16(p)}` },
    { text: `⏭ Skip ${i + 1}`, callback_data: `s:${fp16(p)}` },
  ]);
  if (webUrl) buttons.push([{ text: "📄 Full report", url: webUrl }]);
  return { text: textFor(shown), buttons };
}

/** Send the summary; `webUrl` is the report's SAS link (#19). */
export async function telegramReport(
  fetchFn: typeof fetch,
  s: TelegramSettings,
  report: Report,
  webUrl?: string,
  signal?: AbortSignal,
): Promise<void> {
  const { text, buttons } = telegramMessage(report, webUrl);
  const res = await fetchFn(`${TELEGRAM_API}/bot${s.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: s.chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    }),
    ...(signal ? { signal } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (!res.ok || body.ok !== true) {
    // The token is in the URL, so never put the URL in the message.
    throw new TelegramError(
      `telegram: ${body.description ?? `HTTP ${res.status}`}`,
      res.status,
      body.parameters?.retry_after,
    );
  }
}
