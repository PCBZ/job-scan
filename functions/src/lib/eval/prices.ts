// List prices for the evaluation report's cost estimate (#129). Estimates
// only: Azure's bill comes a day or more later, and is the real cost.

import type { TokenUsage } from "../model/types.js";

/** USD per 1M tokens. */
export interface Price {
  input: number;
  cached: number;
  output: number;
}

/** gpt-5.4-mini, Global Standard: the Azure Retail Prices API, 2026-10. */
export const AZURE: Price = { input: 0.75, cached: 0.075, output: 4.5 };

/** Global Standard, by deployed model: the Azure Retail Prices API, 2026-10 (#148). */
export const AZURE_MODELS: Readonly<Record<string, Price>> = {
  "gpt-5.4-mini": AZURE,
  "gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
};

/** A node's price: its model's, or gpt-5.4-mini's for a record that names none or an unknown one. */
export const azurePrice = (model: string | undefined): Price =>
  (model && AZURE_MODELS[model]) || AZURE;

/**
 * Jev 1.13: input only, its answers are numbers. From secondary sources;
 * TypeSafe publishes no pricing page, and says the price may change.
 */
export const JEV: Price = { input: 0.042, cached: 0.042, output: 0 };

/** The nodes whose tokens Jev serves; the rest are Azure OpenAI's. */
export const JEV_NODES: ReadonlySet<string> = new Set(["screen"]);

/** USD for one node's usage: cached input at the cached rate, the rest at full. */
export function costOf(usage: TokenUsage, price: Price): number {
  const cached = Math.min(usage.cached ?? 0, usage.input);
  return (
    ((usage.input - cached) * price.input + cached * price.cached + usage.output * price.output) /
    1_000_000
  );
}
