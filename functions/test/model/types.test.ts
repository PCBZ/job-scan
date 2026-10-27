import { describe, expect, it } from "vitest";
import { addUsage } from "../../src/lib/model/types.js";

describe("addUsage", () => {
  it("sums input, output and cached tokens", () => {
    expect(
      addUsage({ input: 10, output: 2, cached: 8 }, { input: 5, output: 1, cached: 4 }),
    ).toEqual({ input: 15, output: 3, cached: 12 });
  });

  it("keeps cached when only one side reports it, and leaves it out when neither does", () => {
    expect(addUsage({ input: 10, output: 2 }, { input: 5, output: 1, cached: 4 })).toEqual({
      input: 15,
      output: 3,
      cached: 4,
    });
    expect(addUsage({ input: 10, output: 2 }, { input: 5, output: 1 })).toEqual({
      input: 15,
      output: 3,
    });
  });

  it("sums cache writes and reasoning tokens the same way (#160)", () => {
    expect(
      addUsage(
        { input: 10, output: 2, cacheWrite: 6, reasoning: 1 },
        { input: 5, output: 1, cacheWrite: 2 },
      ),
    ).toEqual({ input: 15, output: 3, cacheWrite: 8, reasoning: 1 });
  });

  it("keeps every model that answered, once each (#148)", () => {
    expect(
      addUsage(
        { input: 1, output: 1, models: ["gpt-5.4-nano-2026-03-17"] },
        { input: 1, output: 1, models: ["gpt-5.4-nano-2026-03-17", "gpt-5.4-nano-2026-09-01"] },
      ).models,
    ).toEqual(["gpt-5.4-nano-2026-03-17", "gpt-5.4-nano-2026-09-01"]);
    expect(addUsage({ input: 1, output: 1 }, { input: 1, output: 1 })).not.toHaveProperty("models");
  });
});
