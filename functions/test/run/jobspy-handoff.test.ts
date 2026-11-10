// The Python scanner's files, read by this side's code. Both tests read the
// fixtures under jobspy-scanner/tests/fixtures, which the scanner's own tests
// also compare its output to, so neither side can change the format alone.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messageSchema } from "../../src/functions/collect.js";
import type { Posting } from "../../src/lib/postings/types.js";
import { checkPosting } from "../../src/lib/postings/validate.js";
import { handoffStore, type SourceHandoff, seedFrom } from "../../src/lib/run/handoff.js";
import { fakePostingsContainer } from "./fake-postings.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../jobspy-scanner/tests/fixtures/${name}`, import.meta.url), "utf8");

const message = messageSchema.parse(JSON.parse(fixture("message.json")));

// Written out so a field added to either type fails to compile until this knows it.
const HANDOFF_KEYS: Record<keyof SourceHandoff, true> = {
  version: true,
  source: true,
  day: true,
  started_at: true,
  trace: true,
  node_ms: true,
  throttled_ms: true,
  rate_limited: true,
  mail: true,
  extracted: true,
  postings: true,
  dropped: true,
  suspicious: true,
  usage: true,
  extract_loop: true,
  warnings: true,
};
const POSTING_KEYS: Record<Exclude<keyof Posting, "gate_questions" | "gate_notes">, true> = {
  title: true,
  company: true,
  location: true,
  workplace: true,
  salary: true,
  posted: true,
  requirements: true,
  skills: true,
  link: true,
  url: true,
  source: true,
  account: true,
  message_id: true,
  message_subject: true,
  row: true,
};

async function stored() {
  const { container, blobs } = fakePostingsContainer();
  blobs.set(message.blob, Buffer.from(fixture("handoff.json")));
  return handoffStore(container);
}

describe("the Python scanner's handoff", () => {
  it("is found, and read, the way the mail source's is", async () => {
    const store = await stored();
    expect(await store.latest(message.day, message.source)).toBe(message.blob);
    const handoff = await store.read(message.blob);
    expect(handoff.source).toBe("jobspy");
    expect(Object.keys(handoff).sort()).toEqual(Object.keys(HANDOFF_KEYS).sort());
  });

  it("holds postings of the shape this side carries, which pass its checks", async () => {
    const handoff = await (await stored()).read(message.blob);
    expect(handoff.postings.length).toBeGreaterThan(0);
    for (const p of handoff.postings) {
      expect(Object.keys(p).sort()).toEqual(Object.keys(POSTING_KEYS).sort());
      expect(checkPosting(p)).toEqual([]);
    }
  });

  it("seeds the collect graph with the postings and the rows it dropped", async () => {
    const handoff = await (await stored()).read(message.blob);
    const seed = seedFrom([handoff]);
    expect(seed.postings).toHaveLength(handoff.postings.length);
    expect(seed.dropped).toEqual({ indeed: 1 });
    expect(seed.mail).toBeNull();
  });
});
