import { describe, expect, it } from "vitest";
import { configPrices, legacyModel, meterNames, retailPrices } from "../../src/lib/eval/prices.js";
import { MINI_PRICE, NANO_PRICE } from "./records.js";
import { meterRow, modelRows, retailApi } from "./retail.js";

/** When the prices are read: a report 15 minutes after its run. */
const REPORT_TIME = () => new Date("2026-10-15T15:15:00Z");
const NANO = NANO_PRICE;
const MINI = MINI_PRICE;

describe("meterNames", () => {
  it("names a deployment's Global Standard meters as the Retail Prices API does", () => {
    expect(meterNames("gpt-5.4-nano")).toEqual({
      input: "5.4 nano Inp Gl 1M Tokens",
      cached: "5.4 nano cd Inp Gl 1M Tokens",
      output: "5.4 nano Opt Gl 1M Tokens",
    });
  });

  it("uses the older names for gpt-5-mini, whose meters don't follow that pattern (#156)", () => {
    expect(meterNames("gpt-5-mini")).toEqual({
      input: "GPT 5 Mini Inpt Glbl 1M Tokens",
      cached: "GPT 5 Mini cchd Inpt Glbl 1M Tokens",
      output: "GPT 5 Mini outpt Glbl 1M Tokens",
    });
  });
});

describe("retailPrices (#148)", () => {
  it("reads each model's three meters, by name, with no region", async () => {
    const api = retailApi([...modelRows("gpt-5.4-nano", NANO), ...modelRows("gpt-5.4-mini", MINI)]);
    const prices = await retailPrices(
      api.fetch,
      REPORT_TIME,
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
    expect(await retailPrices(api.fetch, REPORT_TIME)(["gpt-5.4-nano"])).toEqual({
      "gpt-5.4-nano": NANO,
    });
    expect(api.urls).toHaveLength(2);
  });

  it("takes the latest price in effect, not an older or a future one", async () => {
    const m = meterNames("gpt-5.4-nano");
    const api = retailApi([
      meterRow(m.input, 3, "2026-03-01T00:00:00Z"),
      meterRow(m.input, 2, "2026-06-01T00:00:00Z"),
      meterRow(m.input, 1, "2026-11-01T00:00:00Z"),
      meterRow(m.cached, 0.2),
      meterRow(m.output, 9),
    ]);
    expect(
      (await retailPrices(api.fetch, REPORT_TIME)(["gpt-5.4-nano"]))["gpt-5.4-nano"]?.input,
    ).toBe(2);
  });

  it("leaves out a model with a meter missing", async () => {
    const api = retailApi(modelRows("gpt-5.4-nano", NANO).slice(0, 2));
    expect(await retailPrices(api.fetch, REPORT_TIME)(["gpt-5.4-nano", "gpt-9-new"])).toEqual({});
  });

  it("throws when a meter has two prices at once, or the API fails", async () => {
    const m = meterNames("gpt-5.4-nano");
    const twice = retailApi([...modelRows("gpt-5.4-nano", NANO), meterRow(m.output, 3)]);
    await expect(retailPrices(twice.fetch, REPORT_TIME)(["gpt-5.4-nano"])).rejects.toThrow(
      "5.4 nano Opt Gl 1M Tokens has 2 prices",
    );
    const down = retailApi([], { status: 503 });
    await expect(retailPrices(down.fetch, REPORT_TIME)(["gpt-5.4-nano"])).rejects.toThrow(
      "answered 503",
    );
  });
});

describe("configPrices", () => {
  it("gives every model config's price, cached input at the input rate; none without config", async () => {
    expect(await configPrices({ input: 0.1, output: 0 })(["jev-1.13.0"])).toEqual({
      "jev-1.13.0": { input: 0.1, cached: 0.1, output: 0 },
    });
    expect(await configPrices(undefined)(["jev-1.13.0"])).toEqual({});
  });
});

describe("legacyModel", () => {
  it("is what each node ran before records named their models", () => {
    expect(legacyModel("screen")).toEqual({ provider: "jev", model: "jev-1.13.0" });
    expect(legacyModel("judge")).toEqual({ provider: "azure-openai", model: "gpt-5.4-mini" });
  });
});
