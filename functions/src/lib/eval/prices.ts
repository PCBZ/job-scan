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
}

/** What a report prices: each Azure OpenAI model it found, and Jev when config gives it. */
export interface Prices {
  azure: Readonly<Record<string, Price>>;
  jev: Price | null;
  /** The day Azure's were read, for the report's footer; null when they weren't. */
  azureOn: string | null;
}

export const NO_PRICES: Prices = { azure: {}, jev: null, azureOn: null };

/** The nodes whose tokens Jev serves; the rest are Azure OpenAI's. */
export const JEV_NODES: ReadonlySet<string> = new Set(["screen"]);

/** Every Azure node's model before run records named them (#148). */
export const LEGACY_AZURE_MODEL = "gpt-5.4-mini";

/** USD for one node's usage: cached input at the cached rate, the rest at full. */
export function costOf(usage: TokenUsage, price: Price): number {
  const cached = Math.min(usage.cached ?? 0, usage.input);
  return (
    ((usage.input - cached) * price.input + cached * price.cached + usage.output * price.output) /
    1_000_000
  );
}

/** https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices */
export const RETAIL_PRICES_URL = "https://prices.azure.com/api/retail/prices";
const API_VERSION = "2023-01-01-preview";

/**
 * A deployment's Global Standard meters, as the Retail Prices API names them:
 * gpt-5.4-nano is "5.4 nano Inp Gl", "5.4 nano cd Inp Gl" (cached input) and
 * "5.4 nano Opt Gl", each per 1M tokens.
 */
export function meterNames(model: string): Record<keyof Price, string> {
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

export type AzurePriceSource = (models: string[]) => Promise<Record<string, Price>>;

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
): AzurePriceSource {
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
      if (input !== null && cached !== null && output !== null)
        out[model] = { input, cached, output };
    }
    return out;
  };
}

/** Jev's price from config; it caches nothing, so cached input costs as much as input. */
export const jevPrice = (
  configured: { input: number; output: number } | undefined,
): Price | null => (configured === undefined ? null : { ...configured, cached: configured.input });
