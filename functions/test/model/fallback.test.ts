import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FallbackClient } from "../../src/lib/model/fallback.js";
import {
  type ModelClient,
  ModelOutputError,
  ModelProviderError,
} from "../../src/lib/model/types.js";

const REQ = { name: "x", system: "s", user: "u", schema: z.object({ ok: z.boolean() }) };

function client(label: string, outcome: Error | null, calls: string[]): ModelClient {
  return {
    async structured() {
      calls.push(label);
      if (outcome) throw outcome;
      return { value: { ok: true } as never, usage: { input: 1, output: 1 }, served_by: label };
    },
  };
}

describe("FallbackClient", () => {
  it("uses the primary when it answers", async () => {
    const calls: string[] = [];
    const out = await new FallbackClient(
      client("primary", null, calls),
      client("fallback", null, calls),
    ).structured(REQ);
    expect(out.served_by).toBe("primary");
    expect(calls).toEqual(["primary"]);
  });

  it("asks the fallback once when the provider failed, and reports why", async () => {
    const calls: string[] = [];
    const reasons: string[] = [];
    const out = await new FallbackClient(
      client("primary", new ModelProviderError("503 overloaded", 503), calls),
      client("fallback", null, calls),
      (e) => reasons.push(e.message),
    ).structured(REQ);
    expect(out.served_by).toBe("fallback");
    expect(calls).toEqual(["primary", "fallback"]);
    expect(reasons).toEqual(["503 overloaded"]);
  });

  it("does not hide an output problem behind the fallback", async () => {
    const calls: string[] = [];
    await expect(
      new FallbackClient(
        client("primary", new ModelOutputError("output did not match the schema"), calls),
        client("fallback", null, calls),
      ).structured(REQ),
    ).rejects.toBeInstanceOf(ModelOutputError);
    expect(calls).toEqual(["primary"]);
  });
});
