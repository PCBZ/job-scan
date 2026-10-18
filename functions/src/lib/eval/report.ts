// The evaluation report job (#129): from a queued message naming a run's
// record, read it and the runs before it, work out the figures, and email
// them. Sending is the last step, so a failure before it never sends twice;
// a thrown error goes back to the queue, which retries it.
//
// It waits for all its data (#130): until the run's trace is in Application
// Insights, the message goes back on the queue, a few times, before the email
// goes out without the latency. A mark beside the run record lets only one
// message per run send, whatever the queue redelivers.

import type { Transporter } from "nodemailer";
import { z } from "zod";
import type { AppConfig } from "../config/load.js";
import { runDay } from "../day.js";
import { type EmailSettings, emailEvaluation, emailSettings } from "../delivery/email.js";
import type { EvalMessage, SmokeResult } from "../run/eval-queue.js";
import type { RunRecord, RunRecordReader, RunStatsRecord, SentMarks } from "../run/records.js";
import { evaluate, modelOf, modelsUsed } from "./evaluate.js";
import type { Latency, LatencySource } from "./latency.js";
import { configPrices, modelKey, type Price, type PriceSource, type Prices } from "./prices.js";

/** The runs before this one that the trend shows. */
export const TREND_RUNS = 6;

/** How often the report waits for the run's trace, and how long each time. */
export const LATENCY_WAITS = 5;
export const LATENCY_WAIT_SECONDS = 10 * 60;

export const evalMessage = z.object({
  record: z.string().min(1),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  startedAt: z.string().min(1),
  /** Times the report has already waited for the trace (#130). */
  waited: z.number().int().nonnegative().default(0),
});

/** CD's post-deploy smoke test (#134): report on the latest run, and say how it went. */
export const smokeMessage = z.object({
  smoke: z.literal(true),
  id: z.string().min(1).max(100),
});

/** A smoke test's copy says so in its subject. */
export const SMOKE_PREFIX = "[SMOKE] ";

export interface EvalReportDeps {
  env: Record<string, string | undefined>;
  config: () => Promise<AppConfig>;
  records: RunRecordReader;
  transport: (settings: EmailSettings) => Pick<Transporter, "sendMail">;
  latency: LatencySource;
  /** Puts the message back on the queue, hidden for `delaySeconds`. */
  requeue: (message: EvalMessage, delaySeconds: number) => Promise<void>;
  sent: SentMarks;
  /** Where a smoke test's outcome goes, for CD to wait on (#134). */
  smokeResult: (result: SmokeResult) => Promise<void>;
  /** Azure OpenAI's list prices, read on each report (#148). */
  azurePrices: PriceSource;
  now?: () => Date;
}

export interface EvalReportLog {
  log(message: string): void;
}

/**
 * The queue entry is `unknown`, as the Functions SDK types it: parsed JSON,
 * or the JSON text when the runtime didn't parse it. The schema checks it.
 */
export async function runEvalReport(
  queueEntry: unknown,
  d: EvalReportDeps,
  log: EvalReportLog,
): Promise<void> {
  const entry = typeof queueEntry === "string" ? JSON.parse(queueEntry) : queueEntry;
  const smoke = smokeMessage.safeParse(entry);
  if (smoke.success) return runSmoke(smoke.data.id, d, log);
  const m = evalMessage.parse(entry);
  const config = await d.config();
  const settings = emailSettings(config, d.env);
  if (!settings) {
    log.log(`evalReport: no report.email_account, so no evaluation email for ${m.record}`);
    return;
  }
  const records = await d.records.read(m.record);
  const expectCalls = madeModelCalls(records);
  let latency: Latency | null = null;
  let why = "not in Application Insights yet";
  try {
    latency = await d.latency(m.traceId, new Date(m.startedAt), expectCalls);
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (latency === null && m.waited < LATENCY_WAITS) {
    await d.requeue({ ...m, waited: m.waited + 1 }, LATENCY_WAIT_SECONDS);
    log.log(
      `evalReport: the run's latency is ${why}; waiting for ${m.record} (${m.waited + 1}/${LATENCY_WAITS})`,
    );
    return;
  }
  const earlier = await d.records.earlier(m.record, TREND_RUNS);
  const prices = await pricesFor([...records, ...earlier], config, d, log);
  const evaluation = evaluate(records, earlier, latency, prices);
  // At most one email per run: a second message for it stops here.
  if (!(await d.sent.claim(m.record))) {
    log.log(`evalReport: ${m.record} already has its evaluation email`);
    return;
  }
  try {
    await emailEvaluation(d.transport(settings), settings, evaluation);
  } catch (err) {
    await d.sent.release(m.record);
    throw err;
  }
  log.log(
    `evalReport: sent for ${m.record} (${evaluation.usd === null ? "unpriced" : `≈ $${evaluation.usd.toFixed(2)}`})`,
  );
}

/** A provider's price source, and how the footer names it with and without prices. */
interface PriceSourceOf {
  read: PriceSource;
  found: string;
  missing: string;
}

/** Where each provider's prices come from: an API when one publishes them, config otherwise. */
function priceSources(config: AppConfig, d: EvalReportDeps): Record<string, PriceSourceOf> {
  const day = runDay(d.now?.() ?? new Date());
  return {
    "azure-openai": {
      read: d.azurePrices,
      found: `Azure Retail Prices API, ${day}`,
      missing: "Azure prices unavailable",
    },
    jev: {
      read: configPrices(config.report.jev_usd_per_1m),
      found: "Jev from config",
      missing: "no Jev price in config",
    },
  };
}

/**
 * The prices a report uses: each provider's, for every model these runs used,
 * read now. A source that fails leaves its models unpriced rather than
 * failing the report.
 */
async function pricesFor(
  records: RunRecord[],
  config: AppConfig,
  d: EvalReportDeps,
  log: EvalReportLog,
): Promise<Prices> {
  const runs = records.filter((r): r is RunStatsRecord => r.kind === "run");
  const byProvider = new Map<string, string[]>();
  for (const m of modelsUsed(runs))
    byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m.model]);
  const known = priceSources(config, d);
  const byModel: Record<string, Price> = {};
  const sources: string[] = [];
  for (const [provider, models] of byProvider) {
    const source = known[provider];
    if (!source) {
      sources.push(`no price source for ${provider}`);
      continue;
    }
    try {
      const prices = Object.entries(await source.read(models));
      for (const [model, price] of prices) byModel[modelKey({ provider, model })] = price;
      sources.push(prices.length > 0 ? source.found : source.missing);
    } catch (err) {
      log.log(`evalReport: ${provider} prices unavailable: ${errorText(err)}`);
      sources.push(source.missing);
    }
  }
  return { byModel, sources };
}

/**
 * The providers whose calls the run's trace holds: OpenInference instruments
 * the OpenAI SDK (#101), which these two use.
 */
const TRACED_PROVIDERS: ReadonlySet<string> = new Set(["azure-openai", "openai-compatible"]);

/** Whether a traced node used tokens: then the run's trace isn't complete without its calls. */
function madeModelCalls(records: RunRecord[]): boolean {
  const run = records.find((r): r is RunStatsRecord => r.kind === "run");
  if (!run) return false;
  return Object.entries(run.usage).some(
    ([node, u]) => TRACED_PROVIDERS.has(modelOf(run, node).provider) && u.input > 0,
  );
}

/**
 * The smoke test: the full report on the latest run that kept its trace id,
 * sent with a [SMOKE] subject. It takes no sent mark, so the run's own email
 * isn't blocked, and it never throws: the outcome goes to the result queue
 * for CD, rather than back to this queue for retries and repeat emails.
 */
async function runSmoke(id: string, d: EvalReportDeps, log: EvalReportLog): Promise<void> {
  // Posting the outcome can fail too; it's logged, never thrown, and CD
  // then times out pointing at these logs.
  const post = async (result: SmokeResult) => {
    try {
      await d.smokeResult(result);
    } catch (err) {
      log.log(`evalReport: smoke ${id}: result not posted: ${errorText(err)}`);
    }
  };
  let passed: SmokeResult;
  try {
    const config = await d.config();
    const settings = emailSettings(config, d.env);
    if (!settings) throw new Error("no report.email_account to send to");
    const latest = await d.records.latest();
    if (!latest) throw new Error("no run record with a trace id yet");
    const records = await d.records.read(latest.name);
    const latency = await d.latency(
      latest.run.trace_id,
      new Date(latest.run.started_at),
      madeModelCalls(records),
    );
    if (latency === null)
      throw new Error(`the trace of ${latest.name} isn't in Application Insights`);
    const earlier = await d.records.earlier(latest.name, TREND_RUNS);
    const prices = await pricesFor([...records, ...earlier], config, d, log);
    const evaluation = evaluate(records, earlier, latency, prices);
    const subject = await emailEvaluation(
      d.transport(settings),
      settings,
      evaluation,
      SMOKE_PREFIX,
    );
    passed = { id, ok: true, record: latest.name, subject };
  } catch (err) {
    const error = errorText(err);
    await post({ id, ok: false, error });
    log.log(`evalReport: smoke ${id} failed: ${error}`);
    return;
  }
  // Outside the try: once the email is out, a result that won't post isn't a failure.
  await post(passed);
  log.log(`evalReport: smoke ${id} passed on ${passed.record}`);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
