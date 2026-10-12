import { InvocationContext, type Timer } from "@azure/functions";
import { describe, expect, it } from "vitest";
import { daily } from "../src/functions/daily.js";

describe("daily", () => {
  it("fails loudly, naming what's missing, when the app isn't configured", async () => {
    const timer: Timer = {
      isPastDue: false,
      schedule: { adjustForDST: false },
      scheduleStatus: { last: "", next: "", lastUpdated: "" },
    };
    const run = daily(timer, new InvocationContext());
    await expect(run).rejects.toMatchObject({ code: "config" });
    await expect(run).rejects.toThrow("missing app settings: CONFIG_BLOB_URL");
  });
});
