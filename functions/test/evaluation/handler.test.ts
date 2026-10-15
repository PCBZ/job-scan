import { InvocationContext } from "@azure/functions";
import type { TokenCredential } from "@azure/identity";
import { describe, expect, it } from "vitest";
import { evalReportHandler, productionDeps } from "../../src/functions/eval-report.js";
import type { EvalReportDeps } from "../../src/lib/eval/report.js";

const credential: TokenCredential = { getToken: async () => null };
const MESSAGE = {
  record: "2026-10-15/run.jsonl",
  traceId: "0af7651916cd43dd8448eb211c80319c",
  startedAt: "2026-10-15T15:00:00.000Z",
};

describe("evalReportHandler", () => {
  it("builds its dependencies from the credential it's given, and runs the report", async () => {
    const given: TokenCredential[] = [];
    const read: string[] = [];
    const make = (_env: Record<string, string | undefined>, c: TokenCredential): EvalReportDeps => {
      given.push(c);
      return {
        env: {},
        config: async () => ({ report: {} }) as never,
        records: {
          read: async (name) => {
            read.push(name);
            return [];
          },
          earlier: async () => [],
        },
        transport: () => ({ sendMail: async () => ({}) }) as never,
      };
    };
    await evalReportHandler(make)(MESSAGE, new InvocationContext(), credential);
    expect(given).toEqual([credential]);
    // No report.email_account: it stops before reading.
    expect(read).toEqual([]);
  });
});

describe("productionDeps", () => {
  it("names every app setting it's missing at once", () => {
    expect(() => productionDeps({}, credential)).toThrow(/CONFIG_BLOB_URL[\s\S]*RUN_RECORDS_URL/);
  });

  it("checks the settings are URLs", () => {
    expect(() =>
      productionDeps({ CONFIG_BLOB_URL: "not a url", RUN_RECORDS_URL: "https://a/b" }, credential),
    ).toThrow(/CONFIG_BLOB_URL/);
  });
});
