// Prices for the evaluation report's cost estimate (#129). Estimates only:
// Azure's bill comes a day or more later, and is the real cost.
//
// Azure OpenAI's come from the Azure Retail Prices API on each report (#148),
// so a price change reaches the report without a release; Jev's, which no API
// publishes, from config. None is written here.

import { z } from "zod";
import type { TokenUsage } from "../model/types.js";

/** USD per 1M tokens. */
export interface Price {
  input: number;
  cached: number;
  output: number;
  /** A write to the prompt cache, where the model bills one apart from input (#160). */
  cacheWrite?: number;
}

/** Who served a node, and with which model: "azure-openai" gpt-5.4-nano, "jev" jev-1.13.0. */
export interface NodeModel {
  provider: string;
  model: string;
}

/** A model's key in a price list: "azure-openai/gpt-5.4-nano". */
export const modelKey = (m: NodeModel) => `${m.provider}/${m.model}`;

/** What a report prices with: a price per model key, and where each provider's came from. */
export interface Prices {
  byModel: Readonly<Record<string, Price>>;
  /** One line per provider, for the report's footer. */
  sources: string[];
}

export const NO_PRICES: Prices = { byModel: {}, sources: [] };

/** One provider's prices for the models given, keyed by model name. */
export type PriceSource = (models: string[]) => Promise<Record<string, Price>>;

/**
 * Each node's model before run records named them (#148): Jev's screen and
 * gpt-5.4-mini for the rest, as every release until then ran.
 */
export function legacyModel(node: string): NodeModel {
  return node === "screen"
    ? { provider: "jev", model: "jev-1.13.0" }
    : { provider: "azure-openai", model: "gpt-5.4-mini" };
}

/**
 * USD for one node's usage: cached input at the cached rate, cache writes at
 * the write rate where the model has one, the rest at full.
 */
export function costOf(usage: TokenUsage, price: Price): number {
  const cached = Math.min(usage.cached ?? 0, usage.input);
  const written = Math.min(usage.cacheWrite ?? 0, usage.input - cached);
  return (
    ((usage.input - cached - written) * price.input +
      cached * price.cached +
      written * (price.cacheWrite ?? price.input) +
      usage.output * price.output) /
    1_000_000
  );
}

/** https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices */
export const RETAIL_PRICES_URL = "https://prices.azure.com/api/retail/prices";
const API_VERSION = "2023-01-01-preview";

/** A model's meter names; cacheWrite only where the model bills one. */
type Meters = Record<"input" | "cached" | "output", string> & { cacheWrite?: string };

/**
 * Meter names the 5.x naming below doesn't give: the GPT-5 family's original
 * models are named in the older style, and gpt-5.6 prices a short and a long
 * context apart (#158), a run's prompts being the short one.
 */
const METER_NAMES: Readonly<Record<string, Meters>> = {
  "gpt-5-mini": {
    input: "GPT 5 Mini Inpt Glbl 1M Tokens",
    cached: "GPT 5 Mini cchd Inpt Glbl 1M Tokens",
    output: "GPT 5 Mini outpt Glbl 1M Tokens",
  },
  "gpt-5.6-luna": {
    input: "5.6 luna ShortCo Inp Std Gl 1M Tokens",
    cached: "5.6 luna ShortCo Cd Inp Std Gl 1M Tokens",
    output: "5.6 luna ShortCo Opt Std Gl 1M Tokens",
    cacheWrite: "5.6 luna ShortCo Cd Wr Std Gl 1M Tokens",
  },
};

/**
 * A deployment's Global Standard meters, as the Retail Prices API names them:
 * gpt-5.4-nano is "5.4 nano Inp Gl", "5.4 nano cd Inp Gl" (cached input) and
 * "5.4 nano Opt Gl", each per 1M tokens.
 */
export function meterNames(model: string): Meters {
  const named = METER_NAMES[model];
  if (named) return named;
  const base = model.replace(/^gpt-/, "").replaceAll("-", " ");
  return {
    input: `${base} Inp Gl 1M Tokens`,
    cached: `${base} cd Inp Gl 1M Tokens`,
    output: `${base} Opt Gl 1M Tokens`,
  };
}

const page = z.object({
  Items: z.array(
    z.object({
      meterName: z.string(),
      retailPrice: z.number(),
      currencyCode: z.string(),
      unitOfMeasure: z.string(),
      effectiveStartDate: z.string(),
    }),
  ),
  NextPageLink: z.string().nullable().optional(),
});
type Item = z.infer<typeof page>["Items"][number];

/**
 * Azure OpenAI's list prices from the Retail Prices API, which needs no sign-in.
 * Global meters are listed under many regions, not the account's, so they're
 * found by name alone; each must hold one USD price per 1M tokens, the latest
 * in effect. A model with any meter missing has no price; a failed request or
 * a meter priced two ways throws.
 */
export function retailPrices(
  fetchFn: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): PriceSource {
  return async (models) => {
    const out: Record<string, Price> = {};
    for (const model of new Set(models)) {
      const meters = meterNames(model);
      const names = Object.values(meters);
      const filter = `serviceName eq 'Foundry Models' and priceType eq 'Consumption' and (${names
        .map((n) => `meterName eq '${n}'`)
        .join(" or ")})`;
      const items: Item[] = [];
      let next: string | null | undefined =
        `${RETAIL_PRICES_URL}?api-version=${API_VERSION}&$filter=${encodeURIComponent(filter)}`;
      while (next) {
        const res = await fetchFn(next, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`Azure Retail Prices API answered ${res.status}`);
        const body = page.parse(await res.json());
        items.push(...body.Items);
        next = body.NextPageLink;
      }
      const at = now().toISOString();
      const price = (name: string): number | null => {
        const live = items.filter(
          (i) =>
            i.meterName === name &&
            i.currencyCode === "USD" &&
            i.unitOfMeasure === "1M" &&
            i.effectiveStartDate <= at,
        );
        if (live.length === 0) return null;
        const latest = live.reduce(
          (d, i) => (i.effectiveStartDate > d ? i.effectiveStartDate : d),
          "",
        );
        const values = new Set(
          live.filter((i) => i.effectiveStartDate === latest).map((i) => i.retailPrice),
        );
        if (values.size > 1) throw new Error(`${name} has ${values.size} prices from ${latest}`);
        return [...values][0] ?? null;
      };
      const input = price(meters.input);
      const cached = price(meters.cached);
      const output = price(meters.output);
      const cacheWrite = meters.cacheWrite ? price(meters.cacheWrite) : undefined;
      if (input !== null && cached !== null && output !== null && cacheWrite !== null)
        out[model] = { input, cached, output, ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
    }
    return out;
  };
}

/**
 * A provider whose price no API publishes, from config: every model gets it,
 * with cached input at the input rate, as such a provider caches nothing.
 */
export const configPrices =
  (configured: { input: number; output: number } | undefined): PriceSource =>
  async (models) =>
    configured === undefined
      ? {}
      : Object.fromEntries(models.map((m) => [m, { ...configured, cached: configured.input }]));
