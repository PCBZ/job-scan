import { InvocationContext, type Timer } from "@azure/functions";
import { describe, expect, it } from "vitest";
import { daily } from "../src/functions/daily.js";

const timer: Timer = {
  isPastDue: false,
  schedule: { adjustForDST: false },
  scheduleStatus: { last: "", next: "", lastUpdated: "" },
};
/** 08:00 in Vancouver on a Wednesday, a trading day. */
const TRADING_DAY = () => new Date("2026-11-25T15:00:00Z");

describe("daily", () => {
  it("fails loudly, naming what's missing, when the app isn't configured", async () => {
    const run = daily(timer, new InvocationContext(), TRADING_DAY);
    await expect(run).rejects.toMatchObject({ code: "config" });
    await expect(run).rejects.toThrow("missing app settings: CONFIG_BLOB_URL");
  });

  it("stops before reading anything on a day the market is closed (#212)", async () => {
    // The same unconfigured app: reading any setting would throw, as above.
    for (const [at, why] of [
      ["2026-11-26T15:00:00Z", "Thanksgiving"],
      ["2026-11-28T15:00:00Z", "weekend"],
    ] as const) {
      const logged: unknown[] = [];
      const context = new InvocationContext({
        logHandler: (_level, ...args) => logged.push(...args),
      });
      await expect(daily(timer, context, () => new Date(at))).resolves.toBeUndefined();
      expect(logged).toEqual([`daily: skipped: market closed (${why})`]);
    }
  });
});
