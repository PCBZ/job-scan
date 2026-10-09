import { InvocationContext, type Timer } from "@azure/functions";
import { describe, expect, it } from "vitest";
import { daily } from "../src/functions/daily.js";
import { RunConfigError } from "../src/lib/run/compose.js";

describe("daily", () => {
  it("fails loudly, naming what's missing, when the app isn't configured", async () => {
    const timer: Timer = {
      isPastDue: false,
      schedule: { adjustForDST: false },
      scheduleStatus: { last: "", next: "", lastUpdated: "" },
    };
    const run = daily(timer, new InvocationContext());
    await expect(run).rejects.toBeInstanceOf(RunConfigError);
    await expect(run).rejects.toThrow("missing app settings: CONFIG_BLOB_URL");
  });
});
