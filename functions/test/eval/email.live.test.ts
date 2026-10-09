// One real send of the synthetic sample report, to check the "Done when" of
// #20: it reaches the inbox, not spam. Skipped unless EVAL_LIVE is exactly 1.
// Uses ../config.toml's report.email_account and that account's credentials
// from the environment, the same path the cloud run takes:
//
//   set -a; . ../.env; set +a      # the local skill's credentials
//   npm run eval:email
//
// Then check where it landed in Gmail.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/lib/config/load.js";
import { emailReport, emailSettings, gmailTransport } from "../../src/lib/delivery/email.js";
import { SAMPLE } from "../report/sample.js";

describe.skipIf(process.env.EVAL_LIVE !== "1")("email, live", () => {
  it("sends the sample report to the configured recipient", { timeout: 60_000 }, async () => {
    const path = new URL("../../../config.toml", import.meta.url);
    const settings = emailSettings(
      parseConfig(readFileSync(path, "utf8"), "config.toml"),
      process.env,
    );
    if (!settings) throw new Error("set report.email_account in config.toml to run this");
    const transport = gmailTransport(settings);
    await transport.verify();
    // Marked as a test in the subject, and clearly synthetic in the body.
    await emailReport(transport, settings, { ...SAMPLE, day: `${SAMPLE.day} (test send)` });
    console.log(`sent to ${settings.to}; check Inbox vs Spam`);
    expect(settings.to).toContain("@");
  });
});
