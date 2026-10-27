import { meterNames } from "../../src/lib/eval/prices.js";

/** A synthetic Retail Prices API row for one meter. */
export function meterRow(
  meterName: string,
  retailPrice: number,
  effectiveStartDate = "2026-06-01T00:00:00Z",
) {
  return {
    meterName,
    retailPrice,
    currencyCode: "USD",
    unitOfMeasure: "1M",
    effectiveStartDate,
    armRegionName: "canadaeast",
    serviceName: "Foundry Models",
  };
}

/** Rows for a model's Global meters at these prices. */
export const modelRows = (
  model: string,
  p: { input: number; cached: number; output: number; cacheWrite?: number },
) => {
  const m = meterNames(model);
  return [
    meterRow(m.input, p.input),
    meterRow(m.cached, p.cached),
    meterRow(m.output, p.output),
    ...(m.cacheWrite && p.cacheWrite !== undefined ? [meterRow(m.cacheWrite, p.cacheWrite)] : []),
  ];
};

/**
 * The Retail Prices API over HTTP: answers each request with the rows whose
 * meterName its $filter names, a page of `pageSize` at a time; records the URLs.
 */
export function retailApi(
  rows: ReturnType<typeof meterRow>[],
  o: { status?: number; pageSize?: number } = {},
) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (o.status && o.status !== 200) return new Response("busy", { status: o.status });
    const filter = url.searchParams.get("$filter") ?? "";
    const names = [...filter.matchAll(/meterName eq '([^']+)'/g)].map((m) => m[1]);
    const hits = rows.filter((r) => names.includes(r.meterName));
    const skip = Number(url.searchParams.get("$skip") ?? 0);
    const size = o.pageSize ?? 1000;
    const next = skip + size < hits.length ? new URL(url) : null;
    next?.searchParams.set("$skip", String(skip + size));
    return new Response(
      JSON.stringify({
        Items: hits.slice(skip, skip + size),
        NextPageLink: next?.toString() ?? null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}
