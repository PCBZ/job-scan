import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import {
  fp16,
  TelegramConfigError,
  TelegramError,
  telegramMessage,
  telegramReport,
  telegramSettings,
} from "../../src/lib/delivery/telegram.js";
import type { Report, TopPick } from "../../src/lib/report/types.js";
import { SAMPLE } from "../report/sample.js";

const top = SAMPLE.top[0] as TopPick;
const config = (report: AppConfig["report"]) => ({ report }) as unknown as AppConfig;

describe("telegramSettings", () => {
  it("sends nothing without a chat, and needs the token with one", () => {
    expect(telegramSettings(config({}), { TELEGRAM_BOT_TOKEN: "t" })).toBeNull();
    expect(
      telegramSettings(config({ telegram_chat_id: 123456789 }), { TELEGRAM_BOT_TOKEN: " t " }),
    ).toEqual({
      token: "t",
      chatId: "123456789",
    });
    expect(() => telegramSettings(config({ telegram_chat_id: "@me" }), {})).toThrow(
      TelegramConfigError,
    );
  });
});

describe("fp16", () => {
  it("is 16 hex characters of the fingerprint's SHA-256, alike across wordings", () => {
    const fp = createHash("sha256")
      .update("lumen ridge|backend engineer payments")
      .digest("hex")
      .slice(0, 16);
    expect(fp16(top)).toBe(fp);
    expect(fp16({ company: "Lumen Ridge Inc.", title: "Backend Engineer, Payments" })).toBe(fp);
  });
});

describe("telegramMessage", () => {
  it("summarises each pick in a few lines, under a header with the alerts", () => {
    const { text } = telegramMessage(SAMPLE);
    expect(text).toContain("<b>Job Scan — 2026-10-08</b>");
    expect(text).toContain("⚠️ school mailbox failed to sync");
    expect(text).toContain("→ 2 worth your time.");
    expect(text).toContain(
      "1. <b>Backend Engineer, Payments</b> — Lumen Ridge\n   87/100 (medium) · Vancouver, BC · hybrid · $130K–$150K · send Backend\n   Gap: Experience with Kafka Streams",
    );
    // No stated gap: no Gap line. Either variant named.
    expect(text).toContain(
      "2. <b>Data Engineer</b> — Quillfeather\n   70/100 (low) · Vancouver, BC · send Data or Backend",
    );
    expect(text).not.toMatch(/Gap:\s*$/m);
  });

  it("gives each pick Approve / Skip buttons with short callbacks, then the report link", () => {
    const { buttons } = telegramMessage(SAMPLE, "https://reports.example/x");
    expect(buttons).toEqual([
      [
        { text: "✅ Approve 1", callback_data: `a:${fp16(top)}` },
        { text: "⏭ Skip 1", callback_data: `s:${fp16(top)}` },
      ],
      [
        { text: "✅ Approve 2", callback_data: `a:${fp16(SAMPLE.top[1] as TopPick)}` },
        { text: "⏭ Skip 2", callback_data: `s:${fp16(SAMPLE.top[1] as TopPick)}` },
      ],
      [{ text: "📄 Full report", url: "https://reports.example/x" }],
    ]);
    for (const b of buttons.flat()) {
      if ("callback_data" in b) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it("escapes what Telegram's HTML mode needs", () => {
    const { text } = telegramMessage({
      ...SAMPLE,
      top: [{ ...top, title: "<b>Hi</b> & co", company: "A<B" }],
    });
    expect(text).toContain("<b>&lt;b&gt;Hi&lt;/b&gt; &amp; co</b> — A&lt;B");
  });

  it("still reports an empty day, with only the report link", () => {
    const m = telegramMessage({ ...SAMPLE, top: [] }, "https://reports.example/x");
    expect(m.text).toContain("Nothing cleared the floor today.");
    expect(m.buttons).toEqual([[{ text: "📄 Full report", url: "https://reports.example/x" }]]);
    expect(telegramMessage({ ...SAMPLE, top: [] }).buttons).toEqual([]);
  });

  it("bounds a flood of alerts before any markup, keeping tags and entities whole", () => {
    // The first alert's clip point falls where escaping would put "&amp;".
    const edge = `${"x".repeat(297)}&&&`;
    const alerts = [
      edge,
      ...Array.from(
        { length: 100 },
        (_, i) => `mailbox ${i} failed: <timeout> & ${"x".repeat(1000)}`,
      ),
    ];
    const { text } = telegramMessage({ ...SAMPLE, alerts, top: [] });
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/⚠️ …and \d+ more alerts in the full report\./);
    expect(text).toContain("Nothing cleared the floor today.");
    expect(text.match(/<b>/g)?.length).toBe(text.match(/<\/b>/g)?.length);
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;)/);
    // Each alert is clipped on its plain text, so it ends in an ellipsis, not a cut entity.
    expect(text).toMatch(/x…\n/);
  });

  it("drops picks from the end to fit 4096 characters, and says so", () => {
    const long: TopPick = { ...top, title: "x".repeat(900) };
    const r: Report = { ...SAMPLE, top: Array.from({ length: 6 }, () => long) };
    const { text, buttons } = telegramMessage(r);
    expect(text.length).toBeLessThanOrEqual(4096);
    const shown = (text.match(/^\d+\. /gm) ?? []).length;
    expect(shown).toBeLessThan(6);
    expect(text).toContain(`…and ${6 - shown} more in the full report.`);
    expect(buttons).toHaveLength(shown);
  });
});

describe("telegramReport", () => {
  function fakeFetch(reply: { status?: number; body: unknown }) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }
  const settings = { token: "test-token", chatId: "123456789" };

  it("posts one sendMessage in HTML mode with the inline keyboard", async () => {
    const { fetchFn, calls } = fakeFetch({ body: { ok: true, result: {} } });
    await telegramReport(fetchFn, settings, SAMPLE, "https://reports.example/x");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(calls[0]?.body).toMatchObject({
      chat_id: "123456789",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: telegramMessage(SAMPLE, "https://reports.example/x").buttons,
      },
    });
  });

  it("sends no keyboard when there are no buttons", async () => {
    const { fetchFn, calls } = fakeFetch({ body: { ok: true } });
    await telegramReport(fetchFn, settings, { ...SAMPLE, top: [] });
    expect(calls[0]?.body.reply_markup).toBeUndefined();
  });

  it("fails with Telegram's reason and retry hint, never the token", async () => {
    const { fetchFn } = fakeFetch({
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 7",
        parameters: { retry_after: 7 },
      },
    });
    const err = await telegramReport(fetchFn, settings, SAMPLE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err).toMatchObject({
      status: 429,
      retryAfter: 7,
      message: "telegram: Too Many Requests: retry after 7",
    });
    expect(String((err as Error).message)).not.toContain("test-token");
  });

  it("fails on a reply that isn't ok, even with HTTP 200", async () => {
    const { fetchFn } = fakeFetch({
      body: { ok: false, description: "Bad Request: chat not found" },
    });
    await expect(telegramReport(fetchFn, settings, SAMPLE)).rejects.toThrow("chat not found");
  });
});
