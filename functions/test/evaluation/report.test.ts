import type { ContainerClient } from "@azure/storage-blob";
import { RestError } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { runEvalReport } from "../../src/lib/eval/report.js";
import type { SmokeResult } from "../../src/lib/run/eval-queue.js";
import { type RunRecord, runRecordReader, sentMarks, toJsonl } from "../../src/lib/run/records.js";
import { records, runLine } from "./records.js";

const NAME = "2026-10-15/2026-10-15T15:00:00.000Z-aaaa0000.jsonl";
const MESSAGE = {
  record: NAME,
  traceId: "0af7651916cd43dd8448eb211c80319c",
  startedAt: "2026-10-15T15:00:00.000Z",
};

/** The ContainerClient calls the reader makes, over blobs held here. */
function fakeContainer(blobs: Record<string, string>) {
  const container = {
    getBlockBlobClient: (name: string) => ({
      downloadToBuffer: async () => {
        const text = blobs[name];
        if (text === undefined) throw new Error(`404 ${name}`);
        return Buffer.from(text, "utf8");
      },
    }),
    listBlobsFlat: async function* () {
      for (const name of Object.keys(blobs)) yield { name };
    },
  };
  return container as unknown as ContainerClient;
}

const CONFIG = {
  mail: {
    accounts: [
      {
        name: "personal",
        host: "imap.gmail.com",
        userEnv: "GMAIL_USER",
        passwordEnv: "GMAIL_PASSWORD",
      },
    ],
  },
  report: { email_account: "personal", email_to: "me@example.test" },
} as unknown as AppConfig;
const ENV = { GMAIL_USER: "sender@example.test", GMAIL_PASSWORD: "app-password" };

const LATENCY = {
  calls: 220,
  p50Ms: 3477,
  p95Ms: 6436,
  slowestMs: 9491,
  failed: 0,
  byNode: [{ node: "judge", calls: 179, p50Ms: 3591, p95Ms: 6849, slowestMs: 9491 }],
};

/** The blob calls sentMarks makes, a conditional create and a delete, over `marks`. */
function fakeMarks(marks: Set<string>) {
  return {
    getBlockBlobClient: (name: string) => ({
      upload: async (
        _body: string,
        _length: number,
        o: { conditions?: { ifNoneMatch?: string } },
      ) => {
        if (o.conditions?.ifNoneMatch === "*" && marks.has(name))
          throw new RestError("BlobAlreadyExists", { statusCode: 409 });
        marks.add(name);
        return {};
      },
      deleteIfExists: async () => {
        marks.delete(name);
        return {};
      },
    }),
  } as unknown as ContainerClient;
}

type Source = (
  traceId: string,
  startedAt: Date,
  expectCalls: boolean,
) => Promise<typeof LATENCY | null>;

function harness(
  blobs: Record<string, string>,
  config: AppConfig = CONFIG,
  latency: Source = async () => LATENCY,
  o: { marks?: Set<string>; failSend?: boolean } = {},
) {
  const marks = o.marks ?? new Set<string>();
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const lines: string[] = [];
  const requeued: { message: unknown; delaySeconds: number }[] = [];
  const smokes: SmokeResult[] = [];
  const run = (message: unknown) =>
    runEvalReport(
      message,
      {
        env: ENV,
        config: async () => config,
        records: runRecordReader(fakeContainer(blobs)),
        latency,
        sent: sentMarks(fakeMarks(marks)),
        smokeResult: async (r) => {
          smokes.push(r);
        },
        requeue: async (message, delaySeconds) => {
          requeued.push({ message, delaySeconds });
        },
        transport: () =>
          ({
            sendMail: async (m: { to: string; subject: string; html: string; text: string }) => {
              if (o.failSend) throw new Error("smtp down");
              sent.push(m);
              return {};
            },
          }) as never,
      },
      { log: (m) => lines.push(m) },
    );
  return { run, sent, lines, requeued, marks, smokes };
}

const day = (d: string, over = {}): [string, string] => [
  `${d}/${d}T15:00:00.000Z-x.jsonl`,
  toJsonl([runLine({ started_at: `${d}T15:00:00.000Z`, ...over })]),
];

describe("runEvalReport", () => {
  it("emails the run's evaluation with the runs before it, to the daily report's recipient", async () => {
    const h = harness({
      ...Object.fromEntries([day("2026-10-13"), day("2026-10-14")]),
      [NAME]: toJsonl(records()),
    });
    await h.run(MESSAGE);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.to).toBe("me@example.test");
    expect(h.sent[0]?.subject).toMatch(/^Job Scan — evaluation 2026-10-15/);
    expect(h.sent[0]?.text).toContain("2026-10-13");
    expect(h.sent[0]?.text).toContain("2026-10-14");
    expect(h.lines.at(-1)).toMatch(/^evalReport: sent for 2026-10-15/);
  });

  it("takes the message as JSON text too, as a trigger may hand it over", async () => {
    const h = harness({ [NAME]: toJsonl(records()) });
    await h.run(JSON.stringify(MESSAGE));
    expect(h.sent).toHaveLength(1);
  });

  it("skips an earlier record that won't parse, keeping the rest of the trend", async () => {
    const h = harness({
      "2026-10-13/2026-10-13T15:00:00.000Z-x.jsonl": "{not json\n",
      ...Object.fromEntries([day("2026-10-14")]),
      [NAME]: toJsonl(records()),
    });
    await h.run(MESSAGE);
    expect(h.sent[0]?.text).toContain("2026-10-14");
    expect(h.sent[0]?.text).not.toContain("2026-10-13 |");
  });

  it("fails, for the queue to retry, when the run's own record is missing", async () => {
    await expect(harness({}).run(MESSAGE)).rejects.toThrow("404");
  });

  it("rejects a message without a trace id", async () => {
    await expect(
      harness({ [NAME]: toJsonl(records()) }).run({ record: NAME, startedAt: "x" }),
    ).rejects.toThrow();
  });

  it("sends nothing when the config sends no email", async () => {
    const h = harness({ [NAME]: toJsonl(records()) }, { ...CONFIG, report: {} } as AppConfig);
    await h.run(MESSAGE);
    expect(h.sent).toEqual([]);
    expect(h.lines.at(-1)).toBe(
      `evalReport: no report.email_account, so no evaluation email for ${NAME}`,
    );
  });
});

describe("waiting for the run's trace (#130)", () => {
  it("puts the message back, hidden 10 minutes, while the trace isn't in", async () => {
    const h = harness({ [NAME]: toJsonl(records()) }, CONFIG, async () => null);
    await h.run(MESSAGE);
    expect(h.sent).toEqual([]);
    expect(h.requeued).toEqual([{ message: { ...MESSAGE, waited: 1 }, delaySeconds: 600 }]);
    expect(h.lines.at(-1)).toBe(
      `evalReport: the run's latency is not in Application Insights yet; waiting for ${NAME} (1/5)`,
    );
  });

  it("waits the same way when the query fails", async () => {
    const h = harness({ [NAME]: toJsonl(records()) }, CONFIG, async () => {
      throw new Error("latency query: timed out");
    });
    await h.run({ ...MESSAGE, waited: 2 });
    expect(h.requeued[0]?.message).toMatchObject({ waited: 3 });
    expect(h.lines.at(-1)).toContain("latency is latency query: timed out");
  });

  it("sends without the latency once it has waited five times, and says so", async () => {
    const h = harness({ [NAME]: toJsonl(records()) }, CONFIG, async () => null);
    await h.run({ ...MESSAGE, waited: 5 });
    expect(h.requeued).toEqual([]);
    expect(h.sent[0]?.text).toContain("Model-call latency missing");
  });

  it("puts the latency in the email, per node", async () => {
    const h = harness({ [NAME]: toJsonl(records()) });
    await h.run(MESSAGE);
    expect(h.sent[0]?.text).toContain(
      "220 model calls · p50 3.5s · p95 6.4s · slowest 9.5s · 0 failed",
    );
    expect(h.sent[0]?.text).toContain("judge | 179 | 3.6s | 6.8s | 9.5s");
    expect(h.sent[0]?.html).toContain("p50 3.5s");
  });
});

describe("one evaluation email per run (#130)", () => {
  it("sends once for two messages about the same run", async () => {
    const marks = new Set<string>();
    const blobs = { [NAME]: toJsonl(records()) };
    const first = harness(blobs, CONFIG, undefined, { marks });
    const second = harness(blobs, CONFIG, undefined, { marks });
    await first.run(MESSAGE);
    await second.run(MESSAGE);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toEqual([]);
    expect(second.lines.at(-1)).toBe(`evalReport: ${NAME} already has its evaluation email`);
    expect([...marks]).toEqual([`${NAME}.sent`]);
  });

  it("gives the mark back when sending fails, so the retry sends", async () => {
    const marks = new Set<string>();
    const blobs = { [NAME]: toJsonl(records()) };
    await expect(
      harness(blobs, CONFIG, undefined, { marks, failSend: true }).run(MESSAGE),
    ).rejects.toThrow("smtp down");
    expect(marks.size).toBe(0);
    const retry = harness(blobs, CONFIG, undefined, { marks });
    await retry.run(MESSAGE);
    expect(retry.sent).toHaveLength(1);
  });

  it("tells the latency source whether the run made model calls", async () => {
    const asked: boolean[] = [];
    const spy: Source = async (_t, _s, expectCalls) => {
      asked.push(expectCalls);
      return LATENCY;
    };
    await harness({ [NAME]: toJsonl(records()) }, CONFIG, spy).run(MESSAGE);
    // No mail that day: no node used any tokens.
    await harness({ [NAME]: toJsonl(records({ usage: {} })) }, CONFIG, spy).run(MESSAGE);
    expect(asked).toEqual([true, false]);
  });
});

describe("the post-deploy smoke test (#134)", () => {
  const TRACED = "2026-10-15/2026-10-15T15:00:00.000Z-aaaa0000.jsonl";
  const OLD = "2026-10-14/2026-10-14T15:00:00.000Z-bbbb0000.jsonl";
  const blobs = {
    [OLD]: toJsonl([runLine({ started_at: "2026-10-14T15:00:00.000Z" })]),
    [TRACED]: toJsonl(records({ trace_id: "0af7651916cd43dd8448eb211c80319c" })),
  };

  it("reports on the latest run with a trace, as [SMOKE], and says it passed", async () => {
    const asked: string[] = [];
    const h = harness(blobs, CONFIG, async (traceId) => {
      asked.push(traceId);
      return LATENCY;
    });
    await h.run({ smoke: true, id: "run-1" });
    expect(asked).toEqual(["0af7651916cd43dd8448eb211c80319c"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.subject).toMatch(/^\[SMOKE\] Job Scan — evaluation 2026-10-15/);
    expect(h.smokes).toEqual([
      { id: "run-1", ok: true, record: TRACED, subject: h.sent[0]?.subject },
    ]);
    // It takes no sent mark: the run's own evaluation email still goes out.
    expect(h.marks.size).toBe(0);
    expect(h.requeued).toEqual([]);
  });

  it("reports a failure instead of throwing, so the queue doesn't retry it", async () => {
    const h = harness(blobs, CONFIG, async () => null);
    await h.run({ smoke: true, id: "run-2" });
    expect(h.sent).toEqual([]);
    expect(h.smokes).toEqual([
      { id: "run-2", ok: false, error: `the trace of ${TRACED} isn't in Application Insights` },
    ]);
  });

  it("fails when no run kept its trace id yet", async () => {
    const h = harness({ [OLD]: blobs[OLD] as string });
    await h.run({ smoke: true, id: "run-3" });
    expect(h.smokes[0]).toEqual({
      id: "run-3",
      ok: false,
      error: "no run record with a trace id yet",
    });
  });
});

describe("runRecordReader", () => {
  it("lists earlier runs newest first, up to the count, and never later ones", async () => {
    const blobs = Object.fromEntries([
      day("2026-10-12"),
      day("2026-10-13"),
      day("2026-10-14"),
      day("2026-10-16"),
    ]);
    const earlier = await runRecordReader(fakeContainer(blobs)).earlier(NAME, 2);
    expect(
      earlier.map((r: RunRecord & { started_at: string }) => r.started_at.slice(0, 10)),
    ).toEqual(["2026-10-14", "2026-10-13"]);
  });

  it("finds the newest run that kept its trace id, skipping older-format records", async () => {
    const blobs = Object.fromEntries([
      day("2026-10-13", { trace_id: "11111111111111111111111111111111" }),
      day("2026-10-14", { trace_id: "22222222222222222222222222222222" }),
      day("2026-10-15"),
    ]);
    const latest = await runRecordReader(fakeContainer(blobs)).latest();
    expect(latest?.name).toBe("2026-10-14/2026-10-14T15:00:00.000Z-x.jsonl");
    expect(latest?.run.trace_id).toBe("22222222222222222222222222222222");
    expect(await runRecordReader(fakeContainer({})).latest()).toBeNull();
  });
});
