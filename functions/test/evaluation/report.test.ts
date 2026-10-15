import type { ContainerClient } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { runEvalReport } from "../../src/lib/eval/report.js";
import { type RunRecord, runRecordReader, toJsonl } from "../../src/lib/run/records.js";
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

function harness(
  blobs: Record<string, string>,
  config: AppConfig = CONFIG,
  latency: () => Promise<typeof LATENCY | null> = async () => LATENCY,
) {
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const lines: string[] = [];
  const requeued: { message: unknown; delaySeconds: number }[] = [];
  const run = (message: unknown) =>
    runEvalReport(
      message,
      {
        env: ENV,
        config: async () => config,
        records: runRecordReader(fakeContainer(blobs)),
        latency,
        requeue: async (message, delaySeconds) => {
          requeued.push({ message, delaySeconds });
        },
        transport: () =>
          ({
            sendMail: async (m: { to: string; subject: string; html: string; text: string }) => {
              sent.push(m);
              return {};
            },
          }) as never,
      },
      { log: (m) => lines.push(m) },
    );
  return { run, sent, lines, requeued };
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
});
