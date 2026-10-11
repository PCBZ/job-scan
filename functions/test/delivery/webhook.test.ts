import { describe, expect, it } from "vitest";
import { handleWebhook, parseCallback, secretMatches } from "../../src/lib/delivery/webhook.js";

const SECRET = "s".repeat(32);
const ENV = { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: "test-token" };
const KEY = "0123456789abcdef";

function harness(env: Record<string, string | undefined> = ENV, reply: unknown = { ok: true }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps = {
    env,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch,
    log: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
  };
  return { deps, calls, logs, errors };
}

const press = (data: string, id = "cb-1") =>
  JSON.stringify({ update_id: 1, callback_query: { id, data, from: { id: 42 } } });

describe("handleWebhook", () => {
  it.each([
    ["no secret header", null],
    ["a wrong secret", "x".repeat(32)],
    ["a prefix of the secret", SECRET.slice(0, 31)],
  ])("rejects a forged request (%s) without calling Telegram", async (_name, header) => {
    const { deps, calls, errors } = harness();
    expect(await handleWebhook({ secretHeader: header, body: press(`a:${KEY}`) }, deps)).toEqual({
      status: 401,
    });
    expect(calls).toEqual([]);
    expect(errors).toEqual(["telegram: rejected a request without the webhook secret"]);
  });

  it("acknowledges a button press with its own callback id", async () => {
    const { deps, calls, logs } = harness();
    const res = await handleWebhook(
      { secretHeader: SECRET, body: press(`s:${KEY}`, "cb-9") },
      deps,
    );
    expect(res).toEqual({ status: 200 });
    expect(calls).toEqual([
      {
        url: "https://api.telegram.org/bottest-token/answerCallbackQuery",
        body: { callback_query_id: "cb-9", text: "⏭ Skip received" },
      },
    ]);
    expect(logs).toEqual([`telegram: skip ${KEY}`]);
  });

  it.each([
    ["a body that isn't JSON", "{not json"],
    ["an update that isn't a callback", JSON.stringify({ update_id: 1, message: { text: "hi" } })],
    ["callback data in another format", press("approve:everything")],
  ])("answers 200 and does nothing for %s, so Telegram doesn't retry", async (_n, body) => {
    const { deps, calls } = harness();
    expect(await handleWebhook({ secretHeader: SECRET, body }, deps)).toEqual({ status: 200 });
    expect(calls).toEqual([]);
  });

  it.each([
    ["no secret set", { ...ENV, TELEGRAM_WEBHOOK_SECRET: undefined }],
    ["a short secret", { ...ENV, TELEGRAM_WEBHOOK_SECRET: "short" }],
    [
      "an unresolved Key Vault reference",
      {
        ...ENV,
        TELEGRAM_WEBHOOK_SECRET:
          "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/telegram-webhook-secret/)",
      },
    ],
    ["no bot token", { ...ENV, TELEGRAM_BOT_TOKEN: " " }],
    [
      "a bot token still a Key Vault reference",
      {
        ...ENV,
        TELEGRAM_BOT_TOKEN:
          "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/telegram-bot-token/)",
      },
    ],
  ])("fails closed with %s, whatever the request carries", async (_n, env) => {
    const { deps, calls } = harness(env);
    const header = env.TELEGRAM_WEBHOOK_SECRET ?? null;
    expect(await handleWebhook({ secretHeader: header, body: press(`a:${KEY}`) }, deps)).toEqual({
      status: 503,
    });
    expect(calls).toEqual([]);
  });

  it("still answers 200 when Telegram refuses the acknowledgement", async () => {
    const { deps, errors } = harness(ENV, { ok: false, description: "query is too old" });
    expect(await handleWebhook({ secretHeader: SECRET, body: press(`a:${KEY}`) }, deps)).toEqual({
      status: 200,
    });
    expect(errors).toEqual(["telegram: answerCallbackQuery failed: telegram: query is too old"]);
  });
});

describe("parseCallback", () => {
  it("reads the summary's buttons only", () => {
    expect(parseCallback(JSON.parse(press(`a:${KEY}`)))).toEqual({
      action: "approve",
      key: KEY,
      callbackId: "cb-1",
    });
    for (const data of [`x:${KEY}`, `a:${KEY}0`, `a:${KEY.toUpperCase()}`, `a:${KEY}\n`, ""]) {
      expect(parseCallback(JSON.parse(press(data))), data).toBeNull();
    }
    expect(parseCallback(null)).toBeNull();
    expect(parseCallback({ callback_query: { id: 1, data: `a:${KEY}` } })).toBeNull();
  });
});

describe("secretMatches", () => {
  it("needs the exact secret", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches("", SECRET)).toBe(false);
    expect(secretMatches(null, SECRET)).toBe(false);
  });
});
