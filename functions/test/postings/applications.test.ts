import { RestError, type TableClient } from "@azure/data-tables";
import { describe, expect, it } from "vitest";
import { fp16 } from "../../src/lib/fingerprint.js";
import { TableApplications } from "../../src/lib/postings/applications.js";
import { judgement, rankedOf } from "../judge/helpers.js";

class FakeTable {
  rows = new Map<string, Record<string, unknown>>();
  fail?: Error;
  async createEntity(e: Record<string, unknown>) {
    if (this.fail) throw this.fail;
    if (this.rows.has(e.rowKey as string)) throw new RestError("exists", { statusCode: 409 });
    this.rows.set(e.rowKey as string, e);
    return {} as never;
  }
}
const store = (t: FakeTable) =>
  new TableApplications(t as unknown as Pick<TableClient, "createEntity">);
const pick = rankedOf(
  judgement({
    posting: { title: "Backend Engineer", company: "Lumen Ridge", url: "https://jobs.example/1" },
  }),
  87,
);

describe("TableApplications.addPending", () => {
  it("adds a pending row per pick, keyed by fp16", async () => {
    const t = new FakeTable();
    await store(t).addPending([pick], "2026-10-09");
    expect(t.rows.get(fp16(pick.posting))).toEqual({
      partitionKey: "application",
      rowKey: fp16(pick.posting),
      status: "pending",
      recommendedOn: "2026-10-09",
      title: "Backend Engineer",
      company: "Lumen Ridge",
      url: "https://jobs.example/1",
      variant: "Backend",
      score: 87,
      account: "personal",
    });
  });

  it("leaves an existing row as it is, approved or not", async () => {
    const t = new FakeTable();
    t.rows.set(fp16(pick.posting), { status: "approved" });
    await store(t).addPending([pick], "2026-10-09");
    expect(t.rows.get(fp16(pick.posting))).toEqual({ status: "approved" });
  });

  it("fails on any other storage error", async () => {
    const t = new FakeTable();
    t.fail = new RestError("forbidden", { statusCode: 403 });
    await expect(store(t).addPending([pick], "2026-10-09")).rejects.toThrow("forbidden");
  });
});
