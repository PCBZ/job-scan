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
});
