// The Telegram webhook (#24): the daily summary's Approve / Skip buttons call
// back here. The endpoint is public, so a request counts only with the secret
// token Telegram was registered with, and only in the button's own format.
// Recording the decision is #25; this acknowledges it.

import { timingSafeEqual } from "node:crypto";
import { callBotApi } from "./telegram.js";

/** The buttons' callback_data, as telegramMessage writes it: "a:" or "s:" and an fp16. */
const CALLBACK_DATA = /^([as]):([0-9a-f]{16})$/u;

/**
 * Telegram allows 1-256 of A-Z, a-z, 0-9, _ and -
 * (https://core.telegram.org/bots/api#setwebhook); we require 32 or more, so
 * the secret can't be guessed.
 */
const SECRET = /^[A-Za-z0-9_-]{32,256}$/u;

export interface Decision {
  action: "approve" | "skip";
  /** The posting's fp16, the key of its application record. */
  key: string;
  callbackId: string;
}

/** A configured secret or token: set, and not a Key Vault reference left unresolved. */
function configured(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && !v.toLowerCase().startsWith("@microsoft.keyvault(") ? v : undefined;
}

/** Compares in constant time, so the response time leaks nothing about the secret. */
export function secretMatches(header: string | null, secret: string): boolean {
  if (header === null) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A button press in the expected format, or null for anything else. */
export function parseCallback(update: unknown): Decision | null {
  const query = (update as { callback_query?: { id?: unknown; data?: unknown } } | null)
    ?.callback_query;
  if (typeof query?.id !== "string" || typeof query.data !== "string") return null;
  const m = CALLBACK_DATA.exec(query.data);
  if (!m) return null;
  return { action: m[1] === "a" ? "approve" : "skip", key: m[2] as string, callbackId: query.id };
}

export interface WebhookDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: { log(message: string): void; error(message: string): void };
}

/**
 * 401 without the secret, and Telegram is never called. With it, always 200,
 * even for an update we ignore: Telegram retries anything else.
 */
export async function handleWebhook(
  request: { secretHeader: string | null; body: string },
  deps: WebhookDeps,
): Promise<{ status: number }> {
  const secret = configured(deps.env.TELEGRAM_WEBHOOK_SECRET);
  const token = configured(deps.env.TELEGRAM_BOT_TOKEN);
  if (!secret || !SECRET.test(secret) || !token) {
    // Fail closed: without a usable secret nothing can be told apart from a forgery.
    deps.log.error("telegram: TELEGRAM_WEBHOOK_SECRET or TELEGRAM_BOT_TOKEN isn't usable");
    return { status: 503 };
  }
  if (!secretMatches(request.secretHeader, secret)) {
    deps.log.error("telegram: rejected a request without the webhook secret");
    return { status: 401 };
  }

  let update: unknown;
  try {
    update = JSON.parse(request.body);
  } catch {
    deps.log.log("telegram: ignored a body that isn't JSON");
    return { status: 200 };
  }
  const decision = parseCallback(update);
  if (!decision) {
    deps.log.log("telegram: ignored an update that isn't a summary button");
    return { status: 200 };
  }

  deps.log.log(`telegram: ${decision.action} ${decision.key}`);
  try {
    // Stops the button's spinner; the decision is recorded in #25.
    await callBotApi(deps.fetch, token, "answerCallbackQuery", {
      callback_query_id: decision.callbackId,
      text: decision.action === "approve" ? "✅ Approve received" : "⏭ Skip received",
    });
  } catch (err) {
    // Too late or refused: the decision still stands, and a retry won't help.
    deps.log.error(`telegram: answerCallbackQuery failed: ${(err as Error).message}`);
  }
  return { status: 200 };
}
