import { describe, expect, it } from "vitest";
import { costOf, jevPrice, meterNames, retailPrices } from "../../src/lib/eval/prices.js";
import { meterRow, modelRows, retailApi } from "./retail.js";

const NOW = () => new Date("2026-10-17T15:00:00Z");
const NANO = { input: 0.2, cached: 0.02, output: 1.25 };
const MINI = { input: 0.75, cached: 0.075, output: 4.5 };

describe("meterNames", () => {
  it("names a deployment's Global Standard meters as the Retail Prices API does", () => {
    expect(meterNames("gpt-5.4-nano")).toEqual({
      input: "5.4 nano Inp Gl 1M Tokens",
      cached: "5.4 nano cd Inp Gl 1M Tokens",
      output: "5.4 nano Opt Gl 1M Tokens",
    });
  });
});

describe("retailPrices (#148)", () => {
  it("reads each model's three meters, by name, with no region", async () => {
    const api = retailApi([...modelRows("gpt-5.4-nano", NANO), ...modelRows("gpt-5.4-mini", MINI)]);
    const prices = await retailPrices(
      api.fetch,
      NOW,
    )(["gpt-5.4-nano", "gpt-5.4-mini", "gpt-5.4-nano"]);
    expect(prices).toEqual({ "gpt-5.4-nano": NANO, "gpt-5.4-mini": MINI });
    expect(api.urls).toHaveLength(2);
    expect(api.urls[0]).toContain(
      "prices.azure.com/api/retail/prices?api-version=2023-01-01-preview",
    );
    expect(api.urls[0]).not.toContain("armRegionName");
  });

  it("follows the next page", async () => {
    const api = retailApi(modelRows("gpt-5.4-nano", NANO), { pageSize: 2 });
    expect(await retailPrices(api.fetch, NOW)(["gpt-5.4-nano"])).toEqual({ "gpt-5.4-nano": NANO });
    expect(api.urls).toHaveLength(2);
  });

  it("takes the latest price in effect, not an older or a future one", async () => {
    const m = meterNames("gpt-5.4-nano");
    const api = retailApi([
      meterRow(m.input, 0.3, "2026-03-01T00:00:00Z"),
      meterRow(m.input, 0.2, "2026-06-01T00:00:00Z"),
      meterRow(m.input, 0.1, "2026-11-01T00:00:00Z"),
      meterRow(m.cached, 0.02),
      meterRow(m.output, 1.25),
    ]);
    expect((await retailPrices(api.fetch, NOW)(["gpt-5.4-nano"]))["gpt-5.4-nano"]?.input).toBe(0.2);
  });

  it("leaves out a model with a meter missing", async () => {
    const api = retailApi(modelRows("gpt-5.4-nano", NANO).slice(0, 2));
    expect(await retailPrices(api.fetch, NOW)(["gpt-5.4-nano", "gpt-9-new"])).toEqual({});
  });

  it("throws when a meter has two prices at once, or the API fails", async () => {
    const m = meterNames("gpt-5.4-nano");
    const twice = retailApi([...modelRows("gpt-5.4-nano", NANO), meterRow(m.output, 1.5)]);
    await expect(retailPrices(twice.fetch, NOW)(["gpt-5.4-nano"])).rejects.toThrow(
      "5.4 nano Opt Gl 1M Tokens has 2 prices",
    );
    const down = retailApi([], { status: 503 });
    await expect(retailPrices(down.fetch, NOW)(["gpt-5.4-nano"])).rejects.toThrow("answered 503");
  });
});

describe("jevPrice", () => {
  it("is config's, cached input at the input rate; none without config", () => {
    expect(jevPrice({ input: 0.05, output: 0 })).toEqual({ input: 0.05, cached: 0.05, output: 0 });
    expect(jevPrice(undefined)).toBeNull();
    expect(
      costOf({ input: 1_000_000, output: 9 }, { input: 0.05, cached: 0.05, output: 0 }),
    ).toBeCloseTo(0.05);
  });
});
