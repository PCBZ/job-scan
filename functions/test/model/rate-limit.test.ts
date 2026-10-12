import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BUDGET_SHARE, estimateTokens, RateLimitedClient } from "../../src/lib/model/rate-limit.js";
import type { ModelClient, StructuredRequest } from "../../src/lib/model/types.js";

// limiter reads performance.now() and waits with setTimeout; fake both.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const schema = z.object({ ok: z.boolean() });
const req = (chars: number, signal?: AbortSignal): StructuredRequest<{ ok: boolean }> => ({
  name: "t",
  system: "",
  user: "x".repeat(chars),
  schema,
  ...(signal ? { signal } : {}),
});
const ONE = () => estimateTokens(req(4000));

/** Records when each call reached the model, and answers with `usage` (default: the estimate). */
function model(usage?: { input: number; output: number }) {
  const calls: { user: number; at: number }[] = [];
  const client: ModelClient = {
    async structured<T>(r: StructuredRequest<T>) {
      calls.push({ user: r.user.length, at: performance.now() });
      return {
        value: { ok: true } as T,
        usage: usage ?? { input: estimateTokens(r), output: 0 },
        served_by: "primary",
      };
    },
  };
  return { client, calls };
}

/** A TPM whose budget is `budget` tokens a minute. */
const tpmFor = (budget: number) => Math.ceil(budget / BUDGET_SHARE);

describe("estimateTokens", () => {
  it("counts the whole prompt at four characters a token, plus room for the answer", () => {
    // 40,000 characters are 10,000 input tokens, plus a quarter for the answer.
    const big = estimateTokens(req(40_000));
    expect(big).toBeGreaterThanOrEqual(12_500);
    expect(big).toBeLessThan(12_600);
    // A tiny prompt still reserves 500 for the answer.
    expect(estimateTokens(req(0))).toBeGreaterThanOrEqual(500);
  });

  it("counts the repair history too", () => {
    const withRepair = { ...req(0), repairs: [{ previous: "y".repeat(4000), problems: [] }] };
    expect(estimateTokens(withRepair)).toBeGreaterThan(estimateTokens(req(0)));
  });
});

describe("RateLimitedClient", () => {
  it("starts with a full minute's budget: calls that fit go at once", async () => {
    const m = model();
    const throttled: number[] = [];
    const limited = new RateLimitedClient(m.client, tpmFor(ONE() * 3), (ms) => throttled.push(ms));
    await limited.structured(req(4000));
    await limited.structured(req(4000));
    expect(m.calls.map((c) => c.at)).toEqual([0, 0]);
    expect(throttled).toEqual([]);
  });

  it("waits for the bucket to refill when the next call doesn't fit, and reports the wait", async () => {
    const m = model();
    const throttled: number[] = [];
    const limited = new RateLimitedClient(m.client, tpmFor(ONE() * 2), (ms) => throttled.push(ms));
    await limited.structured(req(4000));
    await limited.structured(req(4000));
    const third = limited.structured(req(4000));
    await vi.advanceTimersByTimeAsync(60_000);
    await third;
    // The bucket refills two calls' worth a minute, so one call takes ~30 s.
    const at = m.calls[2]?.at ?? 0;
    expect(at).toBeGreaterThan(29_000);
    expect(at).toBeLessThan(31_000);
    expect(throttled).toHaveLength(1);
  });

  it("gives back what an estimate overstated, so cheap answers don't slow the run", async () => {
    // Each call really uses a tenth of its estimate.
    const m = model({ input: Math.floor(ONE() / 10), output: 0 });
    const limited = new RateLimitedClient(m.client, tpmFor(ONE() * 2));
    for (let i = 0; i < 5; i++) await limited.structured(req(4000));
    expect(m.calls.every((c) => c.at === 0)).toBe(true);
  });

  it("takes back what an estimate understated, so the next call waits for it", async () => {
    const m = model({ input: ONE() * 2, output: 0 });
    const limited = new RateLimitedClient(m.client, tpmFor(ONE() * 2));
    await limited.structured(req(4000));
    const next = limited.structured(req(4000));
    await vi.advanceTimersByTimeAsync(60_000);
    await next;
    expect(m.calls[1]?.at ?? 0).toBeGreaterThan(29_000);
  });

  it("sends a call bigger than the whole budget once the bucket is full", async () => {
    const m = model({ input: 100, output: 0 });
    const limited = new RateLimitedClient(m.client, tpmFor(estimateTokens(req(400))));
    await limited.structured(req(40_000));
    expect(m.calls).toHaveLength(1);
  });

  it("admits concurrent calls in arrival order, without overshooting together", async () => {
    const m = model();
    const limited = new RateLimitedClient(m.client, tpmFor(ONE() * 2));
    const all = Promise.all([1, 2, 3].map((i) => limited.structured(req(4000 + i))));
    await vi.advanceTimersByTimeAsync(60_000);
    await all;
    expect(m.calls.map((c) => c.user)).toEqual([4001, 4002, 4003]);
    expect(m.calls.slice(0, 2).map((c) => c.at)).toEqual([0, 0]);
    expect(m.calls[2]?.at ?? 0).toBeGreaterThan(29_000);
  });

  it("stops waiting when the run is cancelled", async () => {
    const m = model();
    const limited = new RateLimitedClient(m.client, tpmFor(ONE()));
    await limited.structured(req(4000));
    const controller = new AbortController();
    const waiting = limited.structured(req(4000, controller.signal));
    controller.abort(new Error("run timed out"));
    await expect(waiting).rejects.toThrow("run timed out");
    expect(m.calls).toHaveLength(1);
  });

  it("keeps what a failed call took", async () => {
    let fail = true;
    const calls: number[] = [];
    const inner: ModelClient = {
      async structured<T>() {
        calls.push(performance.now());
        if (fail) throw new Error("boom");
        return { value: { ok: true } as T, usage: { input: 1, output: 0 }, served_by: "primary" };
      },
    };
    const limited = new RateLimitedClient(inner, tpmFor(ONE()));
    await expect(limited.structured(req(4000))).rejects.toThrow("boom");
    fail = false;
    const next = limited.structured(req(4000));
    await vi.advanceTimersByTimeAsync(60_000);
    await next;
    expect(calls[1] ?? 0).toBeGreaterThan(59_000);
  });
});
