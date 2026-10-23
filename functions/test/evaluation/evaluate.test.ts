import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/lib/eval/evaluate.js";
import { costOf } from "../../src/lib/eval/prices.js";
import { JEV_PRICE, MINI_PRICE, NANO_PRICE, PRICES, records, runLine } from "./records.js";

describe("costOf", () => {
  it("prices cached input at the cached rate, the rest at full", () => {
    // 200K full input, 800K cached, 100K output.
    expect(costOf({ input: 1_000_000, output: 100_000, cached: 800_000 }, MINI_PRICE)).toBeCloseTo(
      0.2 * 1 + 0.8 * 0.1 + 0.1 * 10,
    );
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
      reused: 0,
      top: 1,
    });
  });

  it("counts the judgements reused from the cache, which cost no tokens (#150)", () => {
    const stats = {
      reused: 12,
      written: 30,
      failed_reads: 0,
      failed_writes: 0,
      request_charge: 200,
    };
    expect(evaluate(records({ judgement_cache: stats }), [], null, PRICES).funnel.reused).toBe(12);
    expect(e.funnel.reused).toBe(0);
  });

  it("splits tokens and cost per model, in the order the nodes ran", () => {
    expect(e.cost.map((c) => `${c.provider}/${c.model}`)).toEqual([
      "azure-openai/gpt-5.4-mini",
      "jev/jev-1.13.0",
    ]);
    expect(e.cost[0]).toMatchObject({ input: 1_090_000, output: 116_800, cached: 800_000 });
    expect(e.cost[1]).toMatchObject({ input: 30_000, output: 0, cached: 0 });
    expect(e.cost[1]?.usd).toBeCloseTo(0.03 * JEV_PRICE.input);
    expect(e.usd).toBeCloseTo((e.cost[0]?.usd ?? 0) + (e.cost[1]?.usd ?? 0));
    expect(e.priceSources).toEqual(PRICES.sources);
  });

  it("prices each node at its model's rates; a record naming none ran as before #148", () => {
    const azure = (model: string) => ({ provider: "azure-openai", model });
    const nano = evaluate(
      records({
        models: {
          extract_postings: azure("gpt-5.4-nano"),
          judge: azure("gpt-5.4-mini"),
          explain: azure("gpt-5.4-mini"),
          screen: { provider: "jev", model: "jev-1.13.0" },
        },
      }),
      [],
      null,
      PRICES,
    );
    expect(nano.cost.map((c) => c.model)).toEqual(["gpt-5.4-nano", "gpt-5.4-mini", "jev-1.13.0"]);
    const extract = runLine().usage.extract_postings ?? { input: 0, output: 0 };
    expect(nano.cost[0]?.usd).toBeCloseTo(costOf(extract, NANO_PRICE));
  });

  it("leaves a cost unpriced, never guessed, when its price is missing", () => {
    const none = evaluate(records(), [], null, { byModel: {}, sources: [] });
    expect(none.cost.map((c) => c.usd)).toEqual([null, null]);
    expect(none.usd).toBeNull();
    expect(none.trend.at(-1)?.usd).toBeNull();
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
