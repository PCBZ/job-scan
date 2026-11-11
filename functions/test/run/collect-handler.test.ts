import { InvocationContext } from "@azure/functions";
import type { TokenCredential } from "@azure/identity";
import { describe, expect, it } from "vitest";
import { collectHandler } from "../../src/functions/collect.js";
import { runIngest } from "../../src/lib/run/ingest.js";
import { fakes } from "../workflow/fakes.js";

const credential: TokenCredential = { getToken: async () => null };
const quiet = { log: () => {}, error: () => {} };

describe("collectHandler", () => {
  it("builds the pipeline from the credential it's given and collects the message's day", async () => {
    const f = fakes();
    await runIngest(f, quiet);
    // The jobspy scanner's file, so collect has every source and runs.
    const mailFile = await f.handoffs.read(f.handoffMessages[0]?.blob ?? "");
    await f.handoffs.write({
      ...mailFile,
      source: "jobspy",
      mail: null,
      extracted: [],
      postings: [],
    });
    const given: TokenCredential[] = [];
    const make = (_env: Record<string, string | undefined>, c: TokenCredential) => {
      given.push(c);
      return f;
    };
    await collectHandler(make)(f.handoffMessages[0], new InvocationContext(), credential);
    expect(given).toEqual([credential]);
    expect(f.log).toContain("deliver");
    expect(f.log).toContain("mark_seen");
  });

  it("rejects a message that isn't a handoff, before building anything", async () => {
    const make = () => {
      throw new Error("should not build");
    };
    await expect(
      collectHandler(make)({ record: "x" }, new InvocationContext(), credential),
    ).rejects.toThrow();
  });
});
