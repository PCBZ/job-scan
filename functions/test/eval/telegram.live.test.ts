// One real Telegram send of the synthetic sample report, to check #21's
// "Done when": the message arrives, the report link opens, and the buttons
// show. (Pressing them needs the webhook, #24.) Skipped unless EVAL_LIVE is
// exactly 1. Uses ../config.toml's report.telegram_chat_id:
//
//   export TELEGRAM_BOT_TOKEN=...
//   npm run eval:telegram

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/lib/config/load.js";
import { telegramReport, telegramSettings } from "../../src/lib/delivery/telegram.js";
import { SAMPLE } from "../report/sample.js";

describe.skipIf(process.env.EVAL_LIVE !== "1")("telegram, live", () => {
  it("sends the sample summary to the configured chat", { timeout: 60_000 }, async () => {
    const path = new URL("../../../config.toml", import.meta.url);
    const settings = telegramSettings(
      parseConfig(readFileSync(path, "utf8"), "config.toml"),
      process.env,
    );
    if (!settings) throw new Error("set report.telegram_chat_id in config.toml to run this");
    // A link that opens: the project's README stands in for the report's SAS link.
    await telegramReport(
      fetch,
      settings,
      { ...SAMPLE, day: `${SAMPLE.day} (test send)` },
      "https://github.com/PCBZ/job-scan#readme",
    );
    console.log(`sent to chat ${settings.chatId}`);
    expect(settings.chatId).not.toBe("");
  });
});
