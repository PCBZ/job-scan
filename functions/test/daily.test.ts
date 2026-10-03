import { InvocationContext, type Timer } from "@azure/functions";
import { describe, expect, it } from "vitest";
import { daily } from "../src/functions/daily.js";

describe("daily", () => {
  it("runs to completion", async () => {
    const timer: Timer = {
      isPastDue: false,
      schedule: { adjustForDST: false },
      scheduleStatus: { last: "", next: "", lastUpdated: "" },
    };
    await expect(daily(timer, new InvocationContext())).resolves.toBeUndefined();
  });
});
