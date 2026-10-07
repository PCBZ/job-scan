import { RestError } from "@azure/data-tables";
import { describe, expect, it } from "vitest";
import { FakeTable, store } from "./fake-table.js";

describe("TableSeenJobsStore", () => {
  it("reads the window in one query on lastSeen", async () => {
    const fake = new FakeTable();
    fake.rows.set("lumen ridge|backend engineer", { rowKey: "lumen ridge|backend engineer" });
    const fps = await store(fake).recommendedSince("2026-09-07");
    expect(fake.filters).toEqual(["PartitionKey eq 'job' and lastSeen ge '2026-09-07'"]);
    expect(fps).toEqual(new Set(["lumen ridge|backend engineer"]));
  });

  it("creates a new pick, and on a repeat keeps firstSeen and moves lastSeen", async () => {
    const fake = new FakeTable();
    const job = { company: "Lumen Ridge Inc.", title: "Backend Engineer" };
    await store(fake).recordRecommended([job], "2026-09-01");
    await store(fake).recordRecommended([job], "2026-10-07");
    expect(fake.calls).toEqual([
      "create lumen ridge|backend engineer",
      "create lumen ridge|backend engineer",
      "update lumen ridge|backend engineer Merge",
    ]);
    expect(fake.rows.get("lumen ridge|backend engineer")).toEqual({
      partitionKey: "job",
      rowKey: "lumen ridge|backend engineer",
      firstSeen: "2026-09-01",
      lastSeen: "2026-10-07",
      title: "Backend Engineer",
      company: "Lumen Ridge Inc.",
    });
  });

  it("writes a fingerprint once, even when two picks share it", async () => {
    const fake = new FakeTable();
    await store(fake).recordRecommended(
      [
        { company: "Lumen Ridge", title: "Backend Engineer" },
        { company: "Lumen Ridge Inc", title: "Backend Engineer" },
      ],
      "2026-10-07",
    );
    expect(fake.calls).toEqual(["create lumen ridge|backend engineer"]);
  });

  it("fails on any other storage error", async () => {
    const fake = new FakeTable();
    fake.fail = new RestError("This request is not authorized", { statusCode: 403 });
    await expect(
      store(fake).recordRecommended([{ company: "A", title: "B" }], "2026-10-07"),
    ).rejects.toThrow("not authorized");
    expect(fake.calls).toEqual(["create a|b"]);
  });
});
