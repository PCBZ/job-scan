import type { ContainerClient } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import type { FetchedMessage, FetchPayload } from "../../src/lib/mail/types.js";
import {
  type RunMeta,
  type RunRecord,
  runRecordStore,
  runRecords,
  toJsonl,
} from "../../src/lib/run/records.js";
import type { State } from "../../src/lib/workflow/state.js";
import { judgement, rankedOf } from "../judge/helpers.js";
import { posting } from "../postings/helpers.js";

const META: RunMeta = {
  started_at: "2026-10-13T15:00:00.000Z",
  version: "v0.1.6",
  node_ms: { judge: 1200 },
  throttled_ms: 50,
};

function message(id: string): FetchedMessage {
  return {
    account: "personal",
    message_id: id,
    from: "alerts@jobs.example.test",
    subject: `Jobs for you ${id}`,
    date: "2026-10-13T14:00:00Z",
    body: `cleaned body of ${id}`,
    body_source: "plain",
    links: [{ text: "Backend Engineer", url: "https://jobs.example.test/1" }],
  } as FetchedMessage;
}

const NO_LOOP = { turns: [], problems: [], retry: false };

/** A run's final state: an empty run, with the fields a test is about. */
function state(over: Partial<State> = {}): State {
  return {
    outcome: "report",
    config: null,
    resumes: null,
    mail: null,
    extracted: [],
    postings: [],
    repeats: 0,
    duplicates: 0,
    filtered: [],
    dropped: {},
    judged: [],
    top: [],
    rest: [],
    explanations: [],
    report: null,
    suspicious: {},
    loops: { extract: NO_LOOP, judge: NO_LOOP, explain: NO_LOOP },
    warnings: [],
    notes: [],
    usage: {},
    ...over,
  };
}

const byKind = <K extends RunRecord["kind"]>(records: RunRecord[], kind: K) =>
  records.filter((r): r is Extract<RunRecord, { kind: K }> => r.kind === kind);

describe("runRecords", () => {
  const a0 = posting({ message_id: "<a@x>", row: 0, title: "Backend Engineer" });
  const a1 = posting({ message_id: "<a@x>", row: 1, title: "Platform Engineer" });
  const b0 = posting({ message_id: "<b@x>", row: 0, title: "Data Engineer" });
  const pick = { ...rankedOf(judgement({ posting: a0 }), 88), variant: "Resume" };
  const full = state({
    mail: { messages: [message("<a@x>"), message("<b@x>")] } as unknown as FetchPayload,
    extracted: [a0, a1, b0],
    filtered: [{ posting: a1, gate: "location", reason: "Toronto only" }],
    judged: [pick.judgement],
    top: [pick],
    explanations: [
      {
        id: "<a@x>#0",
        fit: { sentence: "Built it", quote: "Go" },
        gap: { requirement: "", advice: "Check the years" },
        unknown: "",
      },
    ],
    resumes: {
      variants: [{ path: "General/Resume.tex", name: "Resume", text: "Go and Postgres" }],
      defaultPath: "General/Resume.tex",
      warnings: [],
      stale: false,
      extracted: 0,
    },
    loops: {
      extract: {
        turns: [{ previous: [], problems: ["row 3: title not in message"] }],
        problems: [],
        retry: false,
      },
      judge: { turns: [], problems: ["posting <a@x>#0: quote not found"], retry: false },
      explain: { turns: [], problems: [], retry: false },
    },
    dropped: { glassdoor: 1 },
    repeats: 2,
    duplicates: 1,
    warnings: ["w"],
    usage: { judge: { input: 10, output: 2 } },
  });

  it("writes every posting, attaching each message's text to its first posting only", () => {
    const postings = byKind(runRecords(full, META), "posting");
    expect(postings.map((p) => p.posting.title)).toEqual([
      "Backend Engineer",
      "Platform Engineer",
      "Data Engineer",
    ]);
    expect(postings.map((p) => p.message?.subject)).toEqual([
      "Jobs for you <a@x>",
      undefined,
      "Jobs for you <b@x>",
    ]);
    expect(postings[0]?.message).toMatchObject({
      body: "cleaned body of <a@x>",
      links: [{ text: "Backend Engineer", url: "https://jobs.example.test/1" }],
    });
  });

  it("writes every filter with its gate and reason", () => {
    expect(byKind(runRecords(full, META), "filtered")).toEqual([
      { kind: "filtered", posting: a1, gate: "location", reason: "Toronto only" },
    ]);
  });

  it("writes each pick with its judgement, explanation and the chosen resume's text", () => {
    const [p] = byKind(runRecords(full, META), "pick");
    expect(p).toMatchObject({
      posting: a0,
      score: 88,
      variant: "Resume",
      judgement: pick.judgement.answer,
      explanation: { id: "<a@x>#0", fit: { quote: "Go" } },
      resume: { name: "Resume", path: "General/Resume.tex", text: "Go and Postgres" },
    });
  });

  it("ends with the run: counts, first-pass and unresolved problems, cost and the meta", () => {
    const records = runRecords(full, META);
    expect(records.at(-1)).toEqual({
      kind: "run",
      ...META,
      outcome: "report",
      messages: 2,
      extracted: 3,
      judged: 1,
      filtered: 1,
      top: 1,
      repeats: 2,
      duplicates: 1,
      dropped: { glassdoor: 1 },
      loops: {
        extract: { repairs: 1, first_pass: ["row 3: title not in message"], unresolved: [] },
        judge: {
          repairs: 0,
          first_pass: ["posting <a@x>#0: quote not found"],
          unresolved: ["posting <a@x>#0: quote not found"],
        },
        explain: { repairs: 0, first_pass: [], unresolved: [] },
      },
      warnings: 1,
      usage: { judge: { input: 10, output: 2 } },
    });
  });

  it("still records a run that found no mail", () => {
    const records = runRecords(state({ outcome: "no_mail" }), META);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "run", outcome: "no_mail", messages: 0, top: 0 });
  });

  it("keeps a pick whose variant or explanation is missing, with nulls", () => {
    const [p] = byKind(runRecords({ ...full, explanations: [], resumes: null }, META), "pick");
    expect(p).toMatchObject({ explanation: null, resume: null });
  });
});

describe("toJsonl", () => {
  it("writes one JSON object per line", () => {
    const text = toJsonl(runRecords(state({ outcome: "no_mail" }), META));
    expect(text.endsWith("\n")).toBe(true);
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l).kind),
    ).toEqual(["run"]);
  });
});

describe("runRecordStore", () => {
  function fakeContainer() {
    const uploads: { name: string; body: string; length: number; contentType?: string }[] = [];
    const container = {
      getBlockBlobClient: (name: string) => ({
        upload: async (
          body: Buffer,
          length: number,
          options: { blobHTTPHeaders?: { blobContentType?: string } },
        ) => {
          uploads.push({
            name,
            body: body.toString("utf8"),
            length,
            contentType: options.blobHTTPHeaders?.blobContentType,
          });
          return {};
        },
      }),
    };
    return { container: container as unknown as ContainerClient, uploads };
  }

  it("writes the run under its Vancouver day, named by its start, as JSONL", async () => {
    const { container, uploads } = fakeContainer();
    const records = runRecords(state({ outcome: "no_mail" }), META);
    // 05:00 UTC is still the previous day in Vancouver.
    const name = await runRecordStore(container).write(records, new Date("2026-10-14T05:00:00Z"));
    expect(name).toBe("2026-10-13/2026-10-14T05:00:00.000Z.jsonl");
    expect(uploads).toEqual([
      {
        name,
        body: toJsonl(records),
        length: Buffer.byteLength(toJsonl(records)),
        contentType: "application/x-ndjson; charset=utf-8",
      },
    ]);
  });

  it("gives a rerun on the same day its own blob", async () => {
    const { container, uploads } = fakeContainer();
    const store = runRecordStore(container);
    await store.write([], new Date("2026-10-13T15:00:00Z"));
    await store.write([], new Date("2026-10-13T16:30:00Z"));
    expect(new Set(uploads.map((u) => u.name)).size).toBe(2);
  });
});
