import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/lib/eval/evaluate.js";
import { costOf } from "../../src/lib/eval/prices.js";
import { PRICES, records, runLine } from "./records.js";

describe("costOf", () => {
  it("prices cached input at the cached rate, the rest at full", () => {
    // 200K full input, 800K cached, 100K output.
    const mini = PRICES.azure["gpt-5.4-mini"];
    expect(
      mini && costOf({ input: 1_000_000, output: 100_000, cached: 800_000 }, mini),
    ).toBeCloseTo(0.2 * 0.75 + 0.8 * 0.075 + 0.1 * 4.5);
  });
});

describe("evaluate", () => {
  const e = evaluate(records(), [], null, PRICES);

  it("counts the funnel, telling Jev's filters from code's", () => {
    expect(e.funnel).toEqual({
      messages: 39,
      extracted: 3,
      repeats: 3,
      duplicates: 46,
      codeFiltered: 1,
      screenFiltered: 1,
      judged: 1,
      top: 1,
    });
  });

  it("splits tokens and cost per model, Azure's first, Jev's last", () => {
    expect(e.cost.map((c) => c.model)).toEqual(["gpt-5.4-mini", "Jev"]);
    expect(e.cost[0]).toMatchObject({ input: 1_090_000, output: 116_800, cached: 800_000 });
    expect(e.cost[1]).toMatchObject({ input: 30_000, output: 0, cached: 0 });
    expect(e.cost[1]?.usd).toBeCloseTo(0.03 * 0.042);
    expect(e.usd).toBeCloseTo((e.cost[0]?.usd ?? 0) + (e.cost[1]?.usd ?? 0));
    expect(e.pricedBy).toEqual({ azureOn: "2026-10-17", jev: true });
  });

  it("prices each Azure node at its model's rates; a record naming none used mini (#148)", () => {
    const nano = evaluate(
      records({
        models: {
          extract_postings: "gpt-5.4-nano",
          judge: "gpt-5.4-mini",
          explain: "gpt-5.4-mini",
        },
      }),
      [],
      null,
      PRICES,
    );
    expect(nano.cost.map((c) => c.model)).toEqual(["gpt-5.4-nano", "gpt-5.4-mini", "Jev"]);
    const extract = runLine().usage.extract_postings ?? { input: 0, output: 0 };
    const nanoPrice = PRICES.azure["gpt-5.4-nano"];
    expect(nano.cost[0]?.usd).toBeCloseTo(nanoPrice ? costOf(extract, nanoPrice) : Number.NaN);
  });

  it("leaves a cost unpriced, never guessed, when its price is missing", () => {
    const none = evaluate(records(), [], null, { azure: {}, jev: null, azureOn: null });
    expect(none.cost.map((c) => c.usd)).toEqual([null, null]);
    expect(none.usd).toBeNull();
    expect(none.trend.at(-1)?.usd).toBeNull();
    expect(none.pricedBy).toEqual({ azureOn: null, jev: false });
  });

  it("times the run from start to end, with the TPM wait", () => {
    expect([e.runMs, e.throttledMs, e.rateLimited]).toEqual([493_000, 360_000, 0]);
    expect(evaluate(records({ ended_at: undefined as never }), []).runMs).toBeNull();
  });

  it("counts each loop's first-pass problems, repairs and unresolved", () => {
    expect(e.quality.judge).toEqual({ repairs: 2, firstPass: 3, unresolved: 1 });
    expect(e.quality.extract).toEqual({ repairs: 1, firstPass: 1, unresolved: 0 });
  });

  it("lists what Jev screened out, with its probability, and unsure picks", () => {
    expect(e.screen).toEqual({
      filtered: [
        {
          title: "Full-Stack Developer",
          company: "Intact",
          location: "Montreal",
          gate: "location",
          probability: 0.97,
        },
      ],
      byGate: { location: 1 },
      unsurePicks: 1,
    });
  });

  it("counts dropped rows against extracted ones, per board", () => {
    expect(e.dropped).toEqual([
      { source: "glassdoor", extracted: 2, dropped: 1 },
      { source: "indeed", extracted: 1, dropped: 0 },
    ]);
  });

  it("trends this run after the earlier ones, oldest first, ignoring later runs", () => {
    const earlier = [
      runLine({
        started_at: "2026-10-14T15:00:00.000Z",
        version: "v0.1.7",
        judged: 140,
        usage: {},
      }),
      runLine({ started_at: "2026-10-13T15:00:00.000Z", version: "v0.1.6", usage: {} }),
      runLine({ started_at: "2026-10-16T15:00:00.000Z", version: "later" }),
    ];
    const t = evaluate(records(), earlier).trend;
    expect(t.map((r) => [r.day, r.version])).toEqual([
      ["2026-10-13", "v0.1.6"],
      ["2026-10-14", "v0.1.7"],
      ["2026-10-15", "v0.1.9"],
    ]);
    expect(t.at(-1)?.cachedShare).toBe(0.8);
    expect(t[0]?.cachedShare).toBeNull();
  });

  it("needs the run line", () => {
    expect(() =>
      evaluate(
        records().filter((r) => r.kind !== "run"),
        [],
      ),
    ).toThrow("no run line");
  });
});
