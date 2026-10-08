import { describe, expect, it } from "vitest";
import { CANADA } from "../../src/lib/postings/places/ca.js";
import { UNITED_STATES } from "../../src/lib/postings/places/us.js";
import { countryOf, isPlaceName, regionCode } from "../../src/lib/postings/places.js";

describe("Country implementations", () => {
  it.each([
    [CANADA, "BC", "BC"],
    [CANADA, "British Columbia", "BC"],
    [CANADA, " quebec ", "QC"],
    [CANADA, "WA", undefined],
    [CANADA, "bc", undefined],
    [UNITED_STATES, "WA", "WA"],
    [UNITED_STATES, "Washington", "WA"],
    [UNITED_STATES, "District of Columbia", "DC"],
    [UNITED_STATES, "CA", "CA"],
    [UNITED_STATES, "British Columbia", undefined],
  ])("%#: %s reads %s as %s", (country, text, code) => {
    expect(country.regionCode(text)).toBe(code);
  });

  it("knows its own name and currency", () => {
    expect([CANADA.isCountry("Canada"), CANADA.isCountry("Canadian")]).toEqual([true, false]);
    expect(["United States", "USA", "us"].map(UNITED_STATES.isCountry)).toEqual([true, true, true]);
    expect([CANADA.currency, UNITED_STATES.currency]).toEqual(["CAD", "USD"]);
  });
});

describe("lookups across countries", () => {
  it.each([
    ["Vancouver, BC", "CA"],
    ["Burnaby, British Columbia, Canada (Hybrid)", "CA"],
    ["Toronto, Canada", "CA"],
    ["Seattle, Washington", "US"],
    ["Los Angeles, CA", "US"],
    ["Austin, TX, USA", "US"],
    ["Remote - USA", "US"],
    ["Winston-Salem, NC", "US"],
    ["Remote - Australia", undefined],
    ["Lower Mainland", undefined],
    ["Remote", undefined],
  ])("countryOf(%s) is %s", (location, code) => {
    expect(countryOf(location)?.code).toBe(code);
  });

  it("finds a region code in any country, and tells place names apart", () => {
    expect([regionCode("Ontario"), regionCode("Texas"), regionCode("AI")]).toEqual([
      "ON",
      "TX",
      undefined,
    ]);
    expect(["Canada", "Nova Scotia", "New York", "BC", "Northwind Labs"].map(isPlaceName)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
