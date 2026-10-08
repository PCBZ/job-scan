import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import type { ProfileConfig } from "../../src/lib/config/schema.js";
import {
  annualTop,
  currencyOf,
  hardGatesStep,
  USD_CAD_URL,
  usdCad,
} from "../../src/lib/postings/gates.js";
import type { Posting } from "../../src/lib/postings/types.js";
import { posting } from "./helpers.js";

const VANCOUVER: ProfileConfig = { locations: ["Vancouver", "Burnaby, BC"], open_to_remote: true };

/** Runs the gates on one posting; `rate` counts how often the exchange rate is asked for. */
async function gate(
  p: Posting,
  profile: ProfileConfig = VANCOUVER,
  cadPerUsd: number | null = 1.4,
) {
  let asked = 0;
  const step = hardGatesStep(async () => {
    asked++;
    return cadPerUsd;
  });
  const out = await step([p], { profile } as AppConfig);
  return { ...out, asked };
}

const onsite = (location: string, over: Partial<Posting> = {}) =>
  posting({ location, workplace: "onsite", salary: "", ...over });

describe("location gate", () => {
  it.each([
    "Vancouver, BC",
    "Vancouver, British Columbia, Canada",
    "Burnaby, British Columbia, Canada (On-site)",
    "vancouver",
  ])("keeps a listed city: %s", async (location) => {
    const out = await gate(onsite(location));
    expect(out.kept).toEqual([onsite(location)]);
  });

  it.each([
    "Toronto, ON",
    "Burnaby, WA",
    "Seattle, Washington",
    "Seattle, Washington, US",
    "Calgary, Alberta, Canada",
    "Halifax, Canada",
  ])("filters a placed city it wasn't given: %s", async (location) => {
    const out = await gate(onsite(location));
    expect(out.filtered).toEqual([
      { posting: onsite(location), gate: "location", reason: `outside locations: ${location}` },
    ]);
  });

  it.each([
    "Lower Mainland",
    "Greater Vancouver Area",
    "Greater Vancouver Area, BC",
    "North Vancouver, BC",
    "British Columbia",
    "Canada",
    "Langley, Lower Mainland",
  ])("keeps a place it can't settle, with a question for Jev: %s", async (location) => {
    const out = await gate(onsite(location));
    expect(out.filtered).toEqual([]);
    expect(out.kept[0]?.gate_questions).toEqual([
      `Is "${location}" within commuting distance of Vancouver, Burnaby, BC?`,
    ]);
  });

  it("asks where an unlocated posting can be worked from", async () => {
    const out = await gate(onsite(""));
    expect(out.kept[0]?.gate_questions).toEqual([
      "Can this role be worked from Vancouver, Burnaby, BC?",
    ]);
  });

  it("keeps remote work, by workplace or by location text", async () => {
    for (const p of [onsite("Toronto, ON", { workplace: "remote" }), onsite("Remote")]) {
      expect((await gate(p)).kept).toEqual([p]);
    }
  });

  it("judges remote work by city when the user isn't open to remote", async () => {
    const out = await gate(onsite("Toronto, ON", { workplace: "remote" }), {
      ...VANCOUVER,
      open_to_remote: false,
    });
    expect(out.filtered[0]?.reason).toBe("outside locations: Toronto, ON");
  });

  it('checks a remote scope like "Remote (Canada)", asking when the posting doesn\'t say', async () => {
    const profile = { locations: ["Vancouver", "Remote (Canada)"] };
    expect(
      (await gate(onsite("Canada (Remote)", { workplace: "remote" }), profile)).kept[0]
        ?.gate_questions,
    ).toBeUndefined();
    expect(
      (await gate(onsite("Remote", { workplace: "remote" }), profile)).kept[0]?.gate_questions,
    ).toEqual(["Is this remote role open to someone working from Canada?"]);
  });

  it("passes a remote role in a country scope, by any name of the country", async () => {
    const profile = { locations: ["Vancouver", "Remote (US)"] };
    for (const location of [
      "United States (Remote)",
      "Remote - USA",
      "Seattle, WA",
      "Remote (US)",
    ]) {
      const out = await gate(onsite(location, { workplace: "remote" }), profile);
      expect(out.kept[0]?.gate_questions, location).toBeUndefined();
    }
  });

  it("asks about a remote role whose place isn't the scope, even when the letters are", async () => {
    const profile = { locations: ["Vancouver", "Remote (US)"] };
    for (const location of ["Remote - Australia", "Remote, Belarus", "Remote", "Canada (Remote)"]) {
      const out = await gate(onsite(location, { workplace: "remote" }), profile);
      expect(out.kept[0]?.gate_questions, location).toEqual([
        "Is this remote role open to someone working from US?",
      ]);
    }
  });

  it("matches a scope that isn't a country as whole words, ignoring punctuation", async () => {
    const emea = { locations: ["Remote (EMEA)"] };
    for (const location of ["Remote - EMEA", "Remote (EMEA)"]) {
      const out = await gate(onsite(location, { workplace: "remote" }), emea);
      expect(out.kept[0]?.gate_questions, location).toBeUndefined();
    }
    const americas = await gate(onsite("Remote - Americas", { workplace: "remote" }), emea);
    expect(americas.kept[0]?.gate_questions).toEqual([
      "Is this remote role open to someone working from EMEA?",
    ]);
    // "UK" is inside "Ukraine", but not a word of it.
    const ukraine = await gate(onsite("Remote - Ukraine", { workplace: "remote" }), {
      locations: ["Remote (UK)"],
    });
    expect(ukraine.kept[0]?.gate_questions).toEqual([
      "Is this remote role open to someone working from UK?",
    ]);
  });

  it("passes Canada's remote scope by country too", async () => {
    const profile = { locations: ["Vancouver", "Remote (Canada)"] };
    const out = await gate(onsite("Toronto, ON", { workplace: "remote" }), profile);
    expect(out.kept[0]?.gate_questions).toBeUndefined();
  });

  it("with no locations listed, filters everything that isn't remote", async () => {
    const out = await gate(onsite("Vancouver, BC"), { locations: [] });
    expect(out.filtered[0]?.reason).toBe("not remote, and no locations are listed");
    expect((await gate(onsite("Remote"), { locations: [] })).kept).toHaveLength(1);
  });
});

describe("salary gate", () => {
  const cad = { ...VANCOUVER, min_salary: 130_000, salary_currency: "CAD" as const };
  const at = (salary: string, location = "Vancouver, BC") => onsite(location, { salary });

  it("filters a band whose top is below the floor, in the floor's currency", async () => {
    const out = await gate(at("$85K - $95K"), cad);
    expect(out.filtered[0]?.reason).toBe('salary "$85K - $95K" is below min_salary CA$130,000');
    expect(out.asked).toBe(0);
  });

  it("keeps a band whose top reaches the floor", async () => {
    expect((await gate(at("$110,000–$130,000 a year"), cad)).kept).toHaveLength(1);
  });

  it("converts a US salary with the day's rate before comparing", async () => {
    const remote = { ...cad, locations: ["Vancouver", "Seattle, WA"] };
    const seattle = at("$90K - $95K", "Seattle, WA");
    // 95,000 USD × 1.4 = 133,000 CAD: above the floor.
    const kept = await gate(seattle, remote, 1.4);
    expect(kept.kept).toHaveLength(1);
    expect(kept.asked).toBe(1);
    const low = await gate(seattle, remote, 1.3);
    expect(low.filtered[0]?.reason).toBe(
      'salary "$90K - $95K" (≈ CA$123,500) is below min_salary CA$130,000',
    );
  });

  it("doesn't compare without a rate, and says so", async () => {
    const out = await gate(at("US$90K", "Vancouver, BC"), cad, null);
    expect(out.kept).toHaveLength(1);
    expect(out.notes).toEqual(["salary not compared for 1 posting(s): no exchange rate"]);
  });

  it("doesn't compare an unknown currency, and says so", async () => {
    const out = await gate(onsite("Remote", { salary: "$40K" }), cad);
    expect(out.kept).toHaveLength(1);
    expect(out.notes).toEqual(["salary not compared for 1 posting(s): currency unknown"]);
  });

  it("is off at 0, and falls back to min_salary_usd", async () => {
    expect((await gate(at("$40K"), { ...cad, min_salary: 0 })).kept).toHaveLength(1);
    const usd = await gate(at("US$40K"), { ...VANCOUVER, min_salary_usd: 50_000 });
    expect(usd.filtered[0]?.reason).toBe('salary "US$40K" is below min_salary US$50,000');
  });

  it("never filters a posting that states no salary", async () => {
    const out = await gate(at(""), cad);
    expect(out).toMatchObject({ filtered: [], notes: [], asked: 0 });
  });
});

describe("annualTop", () => {
  it.each([
    ["$105K - $125K (Employer Est.)", 125_000],
    ["$100,000–$120,000 a year", 120_000],
    ["$110K/yr - $130K/yr", 130_000],
    ["$45 - $50 an hour", 104_000],
    ["$45/hr", 93_600],
    ["$8,000 a month", 96_000],
    ["Competitive", null],
    ["$45", null],
  ])("%s → %s", (salary, top) => {
    expect(annualTop(salary)).toBe(top);
  });
});

describe("currencyOf", () => {
  it.each([
    ["CA$95K", "Remote", "CAD"],
    ["$95K CAD", "Remote", "CAD"],
    ["C$95K", "Remote", "CAD"],
    ["US$95K", "Vancouver, BC", "USD"],
    ["$95K USD", "Remote", "USD"],
    ["$95K", "Vancouver, British Columbia, Canada", "CAD"],
    ["$95K", "Toronto, ON", "CAD"],
    ["$95K", "Austin, TX", "USD"],
    ["$95K", "Los Angeles, CA", "USD"],
    ["$95K", "Remote", undefined],
    ["€95K", "Berlin", undefined],
    ["€95K", "Toronto, ON", undefined],
  ])("%s in %s → %s", (salary, location, currency) => {
    expect(currencyOf(posting({ salary, location }))).toBe(currency);
  });
});

describe("keyword gate", () => {
  const profile = {
    ...VANCOUVER,
    exclude_keywords: ["unpaid", "commission only", "C++", "intern"],
  };

  it.each([
    [{ title: "Unpaid Software Intern" }, 'exclude_keywords: "unpaid" in title'],
    [{ salary: "Commission only" }, 'exclude_keywords: "commission only" in salary'],
    [{ requirements: ["Modern C++"] }, 'exclude_keywords: "C++" in requirements'],
  ])("filters %j", async (over, reason) => {
    const out = await gate(onsite("Vancouver, BC", over), profile);
    expect(out.filtered[0]).toMatchObject({ gate: "keyword", reason });
  });

  it("matches whole phrases only", async () => {
    const out = await gate(
      onsite("Vancouver, BC", { title: "International Payments Engineer" }),
      profile,
    );
    expect(out.kept).toHaveLength(1);
  });
});

describe("hardGatesStep", () => {
  it("names the first failing gate, location before salary and keywords", async () => {
    const p = onsite("Toronto, ON", { title: "Unpaid Intern", salary: "$10K" });
    const out = await gate(p, { ...VANCOUVER, min_salary: 50_000, exclude_keywords: ["unpaid"] });
    expect(out.filtered.map((f) => f.gate)).toEqual(["location"]);
  });

  it("doesn't ask for a rate when every salary is in the floor's currency", async () => {
    const out = await gate(onsite("Vancouver, BC", { salary: "$150K" }), {
      ...VANCOUVER,
      min_salary: 100_000,
      salary_currency: "CAD",
    });
    expect(out.asked).toBe(0);
  });
});

describe("usdCad", () => {
  const reply = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it("reads Bank of Canada's latest observation", async () => {
    let url = "";
    const fetchFn = (async (u: string) => {
      url = u;
      return {
        ok: true,
        json: async () => ({ observations: [{ d: "2026-10-06", FXUSDCAD: { v: "1.4226" } }] }),
      };
    }) as unknown as typeof fetch;
    expect(await usdCad(fetchFn)).toBe(1.4226);
    expect(url).toBe(USD_CAD_URL);
  });

  it("gives null on a failed request, an odd body, or a network error", async () => {
    expect(await usdCad(reply({}, false))).toBeNull();
    expect(await usdCad(reply({ observations: [] }))).toBeNull();
    expect(await usdCad(reply({ observations: [{ FXUSDCAD: { v: "n/a" } }] }))).toBeNull();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await usdCad(down)).toBeNull();
  });
});
