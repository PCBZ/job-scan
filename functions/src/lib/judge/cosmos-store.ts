// The judgement cache's store in Azure Cosmos DB (#150): one item per key, whose
// `id` is also its partition key, so reading it is a point read; the container
// expires items itself (infra/bootstrap/cosmos.tf). The app signs in as its
// identity: the account has local auth off, so there is no key.

import { type Container, CosmosClient } from "@azure/cosmos";
import type { TokenCredential } from "@azure/identity";
import { appError } from "../errors.js";
import { type CachedJudgement, JudgementCache, type JudgementStore } from "./cache.js";

interface Options {
  abortSignal?: AbortSignal;
}

/** The part of the SDK's Container the store uses; a test passes a fake of the same shape. */
export interface JudgementContainer {
  item(
    id: string,
    partitionKey: string,
  ): {
    read(
      options?: Options,
    ): Promise<{ resource?: unknown; statusCode: number; requestCharge: number }>;
  };
  items: { upsert(body: unknown, options?: Options): Promise<{ requestCharge: number }> };
}

export function cosmosJudgementStore(container: JudgementContainer): JudgementStore {
  let charged = 0;
  const options = (signal?: AbortSignal): Options => (signal ? { abortSignal: signal } : {});
  return {
    async get(key, signal) {
      try {
        const r = await container.item(key, key).read(options(signal));
        charged += r.requestCharge ?? 0;
        return r.statusCode === 404 ? null : (r.resource ?? null);
      } catch (err) {
        // The SDK answers a missing item with a 404 response, but a miss is never a failure.
        if ((err as { code?: number }).code === 404) return null;
        throw err;
      }
    },
    async put(item: CachedJudgement, signal) {
      const r = await container.items.upsert(item, options(signal));
      charged += r.requestCharge ?? 0;
    },
    requestCharge: () => charged,
  };
}

type Env = Record<string, string | undefined>;

/**
 * The cache the app settings name, or null without COSMOS_ENDPOINT: until the
 * account exists the app judges everything, as before.
 */
export function judgementCacheFromEnv(
  env: Env,
  credential: TokenCredential,
): JudgementCache | null {
  const endpoint = env.COSMOS_ENDPOINT?.trim();
  if (!endpoint) return null;
  const database = env.COSMOS_DATABASE?.trim();
  const container = env.COSMOS_CONTAINER?.trim();
  if (!database || !container) {
    throw appError(
      "config",
      "COSMOS_ENDPOINT is set but COSMOS_DATABASE or COSMOS_CONTAINER isn't",
    );
  }
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  // The SDK's own Container must fit JudgementContainer, or this stops compiling.
  const sdk: Container = client.database(database).container(container);
  return new JudgementCache(cosmosJudgementStore(sdk));
}
