import { describe, expect, it } from "vitest";
import { type SourceHandoff, seedFrom } from "../../src/lib/run/handoff.js";
import { posting } from "../postings/helpers.js";

const NO_LOOP = { turns: [], problems: [], retry: false };

function handoff(over: Partial<SourceHandoff> = {}): SourceHandoff {
  return {
    version: 1,
    source: "mail",
    day: "2026-10-13",
    started_at: "2026-10-13T15:00:00.000Z",
    trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
    node_ms: { fetch_mail: 100, extract_postings: 900 },
    throttled_ms: 5,
    rate_limited: 1,
    mail: null,
    extracted: [],
    postings: [],
    dropped: {},
    suspicious: {},
    usage: {},
    extract_loop: NO_LOOP,
    warnings: [],
    ...over,
  };
}

describe("seedFrom", () => {
  const a = handoff({
    extracted: [posting({ row: 0 })],
    postings: [posting({ row: 0 })],
    dropped: { indeed: 1 },
    usage: { extract_postings: { input: 10, output: 2 } },
    suspicious: { "<m0@x>": [] },
    warnings: ["w1"],
  });
  const b = handoff({
    source: "jobspy",
    started_at: "2026-10-13T12:00:00.000Z",
    trace: null,
    node_ms: { scrape: 4000 },
    throttled_ms: 0,
    rate_limited: 0,
    extracted: [posting({ row: 7, source: "other" })],
    postings: [posting({ row: 7, source: "other" })],
    dropped: { indeed: 2, other: 1 },
    usage: { extract_postings: { input: 5, output: 1 } },
    warnings: ["w2"],
  });

  it("gathers every source's postings and sums what they cost", () => {
    const seed = seedFrom([a, b]);
    expect(seed.postings).toHaveLength(2);
    expect(seed.extracted).toHaveLength(2);
    expect(seed.dropped).toEqual({ indeed: 3, other: 1 });
    expect(seed.usage).toEqual({ extract_postings: { input: 15, output: 3 } });
    expect(seed.warnings).toEqual(["w1", "w2"]);
    expect(seed.suspicious).toEqual({ "<m0@x>": [] });
  });

  it("takes the mail and the extract loop from the mail source only", () => {
    const mail = { messages: [] } as never;
    const seed = seedFrom([b, { ...a, mail, extract_loop: { ...NO_LOOP, problems: ["p"] } }]);
    expect(seed.mail).toBe(mail);
    expect(
      (seed.loops as { extract?: { problems: string[] } } | undefined)?.extract?.problems,
    ).toEqual(["p"]);
    expect(seedFrom([b]).loops).toBeUndefined();
  });
});
