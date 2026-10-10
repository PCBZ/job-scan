import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { TelegramConfigError } from "../../src/lib/delivery/telegram.js";
import type { FetchPayload } from "../../src/lib/mail/types.js";
import { productionEffects } from "../../src/lib/run/effects.js";
import { judgement, rankedOf } from "../judge/helpers.js";
import { SAMPLE } from "../report/sample.js";

const NOW = new Date("2026-10-09T15:00:00Z");
const SAS = "https://acct.blob.core.windows.net/reports/2026-10-08.html?sig=x";

const config = (report: AppConfig["report"]) =>
  ({
    report,
    mail: {
      accounts: [
        {
          name: "gmail-main",
          host: "imap.gmail.com",
          userEnv: "GMAIL_MAIN_USER",
          passwordEnv: "GMAIL_MAIN_PASSWORD",
        },
      ],
    },
  }) as unknown as AppConfig;
const ENV = {
  GMAIL_MAIN_USER: "me@example.test",
  GMAIL_MAIN_PASSWORD: "test-password-a",
  TELEGRAM_BOT_TOKEN: "test-token",
};

function harness(
  over: { emailFails?: boolean; telegramFails?: boolean; env?: Record<string, string> } = {},
) {
  const calls: string[] = [];
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const effects = productionEffects({
    env: over.env ?? ENV,
    publisher: {
      async publish(html, day) {
        calls.push(`publish ${day} ${html.length > 0}`);
        return SAS;
      },
    },
    seen: { markSeen: async (m, day) => void calls.push(`seen ${m.length} ${day}`) },
    seenJobs: { recordRecommended: async (j, day) => void calls.push(`jobs ${j.length} ${day}`) },
    applications: { addPending: async (t, day) => void calls.push(`pending ${t.length} ${day}`) },
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(
        `telegram ${body.chat_id} ${JSON.stringify(body.reply_markup.inline_keyboard.at(-1))}`,
      );
      return new Response(
        JSON.stringify(
          over.telegramFails ? { ok: false, description: "chat not found" } : { ok: true },
        ),
        {
          status: over.telegramFails ? 400 : 200,
        },
      );
    }) as unknown as typeof fetch,
    transport: () => ({
      sendMail: async (m: Parameters<typeof stream.sendMail>[0]) => {
        if (over.emailFails) throw new Error("smtp down");
        calls.push(`email ${m.to} ${String(m.html).includes(">View in a browser</a>")}`);
        return stream.sendMail(m);
      },
    }),
    now: () => NOW,
  });
  return { effects, calls };
}

describe("productionEffects.deliver", () => {
  it("publishes first, then emails and sends to Telegram, both linking the browser copy", async () => {
    const { effects, calls } = harness();
    await effects.deliver(SAMPLE, config({ email_account: "gmail-main", telegram_chat_id: 42 }));
    expect(calls).toEqual([
      "publish 2026-10-08 true",
      "email me@example.test true",
      `telegram 42 [{"text":"📄 Full report","url":"${SAS}"}]`,
    ]);
  });

  it("only publishes when no channel is configured", async () => {
    const { effects, calls } = harness();
    await effects.deliver(SAMPLE, config({}));
    expect(calls).toEqual(["publish 2026-10-08 true"]);
  });

  it("still sends to Telegram when email fails, then fails the delivery", async () => {
    const { effects, calls } = harness({ emailFails: true });
    await expect(
      effects.deliver(SAMPLE, config({ email_account: "gmail-main", telegram_chat_id: 42 })),
    ).rejects.toThrow("smtp down");
    expect(calls.some((c) => c.startsWith("telegram 42"))).toBe(true);
  });

  it("still emails when Telegram's settings are missing, then fails the delivery", async () => {
    const { TELEGRAM_BOT_TOKEN: _token, ...noToken } = ENV;
    const { effects, calls } = harness({ env: noToken });
    await expect(
      effects.deliver(SAMPLE, config({ email_account: "gmail-main", telegram_chat_id: 42 })),
    ).rejects.toThrow(TelegramConfigError);
    expect(calls).toEqual(["publish 2026-10-08 true", "email me@example.test true"]);
  });

  it("names every channel when all of them fail", async () => {
    const { effects } = harness({ emailFails: true, telegramFails: true });
    const err = await effects
      .deliver(SAMPLE, config({ email_account: "gmail-main", telegram_chat_id: 42 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map(String)).toEqual([
      "Error: smtp down",
      "TelegramError: telegram: chat not found",
    ]);
  });
});

describe("productionEffects.markSeen", () => {
  it("records the messages, the recommended postings and a pending row each, on the run's day", async () => {
    const { effects, calls } = harness();
    const mail = {
      messages: [
        { account: "a", message_id: "<1@x>" },
        { account: "a", message_id: "<2@x>" },
      ],
    } as FetchPayload;
    await effects.markSeen({ mail, top: [rankedOf(judgement())] });
    expect(calls).toEqual(["seen 2 2026-10-09", "jobs 1 2026-10-09", "pending 1 2026-10-09"]);
  });
});
