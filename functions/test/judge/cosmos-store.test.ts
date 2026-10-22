import type { TokenCredential } from "@azure/identity";
import { describe, expect, it } from "vitest";
import { CACHE_FORMAT } from "../../src/lib/judge/cache.js";
import {
  cosmosJudgementStore,
  type JudgementContainer,
  judgementCacheFromEnv,
} from "../../src/lib/judge/cosmos-store.js";
import { answer } from "./helpers.js";

const ITEM = { id: "abc", format: CACHE_FORMAT, answer: answer(), judgedOn: "2026-10-22" };

/** The SDK's container as far as the store uses it, answering like the SDK does. */
function container(
  over: {
    read?: () => Promise<{ resource?: unknown; statusCode: number; requestCharge: number }>;
  } = {},
) {
  const reads: { id: string; partitionKey: string; signal?: AbortSignal }[] = [];
  const upserts: { body: unknown; signal?: AbortSignal }[] = [];
  const c: JudgementContainer = {
    item: (id, partitionKey) => ({
      read: async (options) => {
        reads.push({
          id,
          partitionKey,
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
        });
        return over.read ? over.read() : { resource: ITEM, statusCode: 200, requestCharge: 1 };
      },
    }),
    items: {
      upsert: async (body, options) => {
        upserts.push({ body, ...(options?.abortSignal ? { signal: options.abortSignal } : {}) });
        return { requestCharge: 6.1 };
      },
    },
  };
  return { c, reads, upserts };
}

describe("cosmosJudgementStore (#150)", () => {
  it("reads an item by its id, which is also its partition key", async () => {
    const { c, reads } = container();
    const signal = AbortSignal.timeout(1000);
    expect(await cosmosJudgementStore(c).get("abc", signal)).toEqual(ITEM);
    expect(reads).toEqual([{ id: "abc", partitionKey: "abc", signal }]);
  });

  it("takes the SDK's 404 response, and a thrown 404, as no item", async () => {
    const missing = container({ read: async () => ({ statusCode: 404, requestCharge: 1 }) });
    expect(await cosmosJudgementStore(missing.c).get("abc")).toBeNull();
    const thrown = container({
      read: async () => {
        throw Object.assign(new Error("NotFound"), { code: 404 });
      },
    });
    expect(await cosmosJudgementStore(thrown.c).get("abc")).toBeNull();
  });

  it("lets any other failure through, for the cache to count", async () => {
    const down = container({
      read: async () => {
        throw Object.assign(new Error("ServiceUnavailable"), { code: 503 });
      },
    });
    await expect(cosmosJudgementStore(down.c).get("abc")).rejects.toThrow("ServiceUnavailable");
  });

  it("upserts an item as it is, and adds up the request units charged", async () => {
    const { c, upserts } = container();
    const store = cosmosJudgementStore(c);
    await store.get("abc");
    await store.put(ITEM);
    expect(upserts[0]?.body).toBe(ITEM);
    expect(store.requestCharge()).toBeCloseTo(7.1);
  });
});

describe("judgementCacheFromEnv", () => {
  const credential: TokenCredential = { getToken: async () => null };

  it("is no cache without COSMOS_ENDPOINT, so the app judges everything as before", () => {
    expect(judgementCacheFromEnv({ MODEL_NAME: "gpt-5.4-mini" }, credential)).toBeNull();
    expect(judgementCacheFromEnv({ COSMOS_ENDPOINT: " " }, credential)).toBeNull();
  });

  it("refuses an endpoint without its database and container, or without a model", () => {
    const env = { COSMOS_ENDPOINT: "https://acct.documents.azure.com:443/", MODEL_NAME: "m" };
    expect(() => judgementCacheFromEnv(env, credential)).toThrow(
      "COSMOS_ENDPOINT is set but COSMOS_DATABASE or COSMOS_CONTAINER isn't",
    );
    expect(() =>
      judgementCacheFromEnv(
        { ...env, COSMOS_DATABASE: "d", COSMOS_CONTAINER: "c", MODEL_NAME: "" },
        credential,
      ),
    ).toThrow("MODEL_NAME is not set");
  });
});
