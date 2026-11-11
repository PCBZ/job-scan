import { describe, expect, it } from "vitest";
import {
  type HandoffMessage,
  handoffQueue,
  handoffStore,
  mergeMeta,
  type SourceHandoff,
  seedFrom,
} from "../../src/lib/run/handoff.js";
import { posting } from "../postings/helpers.js";
import { fakePostingsContainer, fakePostingsQueue } from "./fake-postings.js";

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

describe("handoffStore", () => {
  it("writes a source's file under its day and source, named by its start", async () => {
    const { container, blobs } = fakePostingsContainer();
    const name = await handoffStore(container).write(handoff());
    expect(name).toMatch(/^2026-10-13\/mail\/2026-10-13T15:00:00\.000Z-[0-9a-f]{8}\.json$/);
    expect(JSON.parse(blobs.get(name)?.toString("utf8") ?? "")).toMatchObject({ source: "mail" });
  });

  it("reads back what it wrote, and refuses a version it doesn't know", async () => {
    const { container, blobs } = fakePostingsContainer();
    const store = handoffStore(container);
    const h = handoff({ postings: [posting()] });
    expect(await store.read(await store.write(h))).toEqual(h);
    blobs.set("2026-10-13/mail/old.json", Buffer.from(JSON.stringify({ version: 2 })));
    await expect(store.read("2026-10-13/mail/old.json")).rejects.toThrow("unknown version");
  });

  it("finds the newest file a source wrote on a day, and none for another", async () => {
    const { container } = fakePostingsContainer();
    const store = handoffStore(container);
    await store.write(handoff({ started_at: "2026-10-13T15:00:00.000Z" }));
    const later = await store.write(handoff({ started_at: "2026-10-13T16:30:00.000Z" }));
    await store.write(handoff({ source: "jobspy", started_at: "2026-10-13T12:00:00.000Z" }));
    expect(await store.latest("2026-10-13", "mail")).toBe(later);
    expect(await store.latest("2026-10-14", "mail")).toBeNull();
    expect(await store.latest("2026-10-13", "collected")).toBeNull();
  });

  // An existing marker answers 409 or 412 depending on the path through the service.
  it.each([409, 412] as const)(
    "lets exactly one caller claim a set of files, in any order (%i)",
    async (status) => {
      const { container } = fakePostingsContainer(status);
      const store = handoffStore(container);
      expect(await store.claim("2026-10-13", ["a.json", "b.json"])).toBe(true);
      expect(await store.claim("2026-10-13", ["b.json", "a.json"])).toBe(false);
      // A different set of files is a different collect: a late source's rerun.
      expect(await store.claim("2026-10-13", ["a.json", "b.json", "c.json"])).toBe(true);
    },
  );

  it("does not take a claim marker for a source's file", async () => {
    const { container } = fakePostingsContainer();
    const store = handoffStore(container);
    await store.claim("2026-10-13", ["a.json"]);
    expect(await store.latest("2026-10-13", "mail")).toBeNull();
  });
});

describe("handoffQueue", () => {
  it("sends plain JSON, hidden for the delay", async () => {
    const { queue, sent } = fakePostingsQueue();
    const message: HandoffMessage = {
      day: "2026-10-13",
      source: "mail",
      blob: "2026-10-13/mail/x.json",
      first_seen: "2026-10-13T15:02:00.000Z",
    };
    await handoffQueue(queue).send(message);
    await handoffQueue(queue).send(message, 300);
    expect(sent.map((m) => [JSON.parse(m.text), m.visibilityTimeout])).toEqual([
      [message, 0],
      [message, 300],
    ]);
  });
});

describe("seedFrom and mergeMeta", () => {
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

  it("carries the scraping source's counts, and none when no source scraped", () => {
    const scrape = { searches: 2, failed: 0, sites: { indeed: { rows: 3, silent: 1 } } };
    expect(seedFrom([a, { ...b, scrape }]).scrape).toEqual(scrape);
    expect(seedFrom([a, b])).not.toHaveProperty("scrape");
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

  it("starts the run at the earliest source and sums its time and waiting", () => {
    expect(mergeMeta([a, b])).toEqual({
      startedAt: "2026-10-13T12:00:00.000Z",
      nodeMs: { fetch_mail: 100, extract_postings: 900, scrape: 4000 },
      throttledMs: 5,
      rateLimited: 1,
      trace: a.trace,
    });
  });
});
