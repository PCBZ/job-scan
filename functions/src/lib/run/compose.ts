// The composition root: every node's dependency, built from app settings.
// Nothing connects here; clients open their connections when a node runs.
//
//   CONFIG_BLOB_URL     config.toml in Blob (#10)
//   RESUME_CACHE_URL    extracted resume texts (#12)
//   REPORTS_URL         the private reports container (#19)
//   TABLES_URL          seenmessages, seenjobs, applications
//   GITHUB_RESUME_PAT   read access to the resume repo (#11, from Key Vault via #47)
//   MODEL_*             the model client (#13)
//   <ACCOUNT>_USER / _PASSWORD, TELEGRAM_BOT_TOKEN  per config (#9, #20, #21)

import type { TokenCredential } from "@azure/identity";
import { blobConfigSource, loadConfig } from "../config/load.js";
import { explainStep } from "../explain/explain.js";
import { verifyExplanations } from "../explain/verify.js";
import { judgeStep } from "../judge/judge.js";
import { rank } from "../judge/rank.js";
import { verifyJudgements } from "../judge/verify.js";
import { type ConnectMailbox, connectImap } from "../mail/mailbox.js";
import { runFetch } from "../mail/run.js";
import { TableSeenStore } from "../mail/seen-store.js";
import { modelClientFromEnv } from "../model/config.js";
import type { ModelProviderError } from "../model/types.js";
import { TableApplications } from "../postings/applications.js";
import { dedupeStep } from "../postings/dedupe.js";
import { extractStep } from "../postings/extract.js";
import { hardGatesStep } from "../postings/gates.js";
import { TableSeenJobsStore } from "../postings/seen-jobs.js";
import { validatePostings } from "../postings/validate.js";
import { reportPublisherFromUrl } from "../report/publish.js";
import { buildReport } from "../report/source.js";
import { GithubRestResumeSource } from "../resume/github-rest.js";
import { loadResumes } from "../resume/load.js";
import { blobTextStore } from "../resume/store.js";
import type { DeterministicSteps, Effects, ModelSteps } from "../workflow/types.js";
import { productionEffects } from "./effects.js";

type Env = Record<string, string | undefined>;

/** App settings every run needs; the per-config ones are checked when used. */
const REQUIRED = [
  "CONFIG_BLOB_URL",
  "RESUME_CACHE_URL",
  "REPORTS_URL",
  "TABLES_URL",
  "GITHUB_RESUME_PAT",
] as const;

export class RunConfigError extends Error {
  override name = "RunConfigError";
}

export interface ComposeOptions {
  fetch?: typeof fetch;
  connect?: ConnectMailbox;
  now?: () => Date;
  /** Told when the model falls back, for the run's warnings. */
  onFallback?: (err: ModelProviderError) => void;
}

/** Everything buildWorkflow runs: the code steps, the model steps and the side effects. */
export interface Pipeline {
  deterministicSteps: DeterministicSteps;
  modelSteps: ModelSteps;
  effects: Effects;
}

export function composePipeline(
  env: Env,
  credential: TokenCredential,
  o: ComposeOptions = {},
): Pipeline {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length) throw new RunConfigError(`missing app settings: ${missing.join(", ")}`);
  const setting = (key: (typeof REQUIRED)[number]) => (env[key] as string).trim();
  const fetchFn = o.fetch ?? fetch;
  const now = o.now ?? (() => new Date());
  const tables = setting("TABLES_URL");

  const seen = TableSeenStore.connect(tables, "seenmessages", credential);
  const seenJobs = TableSeenJobsStore.connect(tables, "seenjobs", credential);
  const configSource = blobConfigSource(setting("CONFIG_BLOB_URL"), credential);
  const resumeStore = blobTextStore(setting("RESUME_CACHE_URL"), credential);
  const client = modelClientFromEnv(
    env,
    credential,
    o.onFallback ? { onFallback: o.onFallback } : {},
  );

  const deterministicSteps: DeterministicSteps = {
    loadConfig: () => loadConfig(configSource),
    loadResumes: (config) =>
      loadResumes(
        config.resume,
        new GithubRestResumeSource(setting("GITHUB_RESUME_PAT"), config.resume, fetchFn),
        resumeStore,
        now(),
      ),
    fetchMail: (config) =>
      runFetch(config.mail, { connect: o.connect ?? connectImap, seen, env, now: now() }),
    validatePostings,
    dedupe: dedupeStep(seenJobs, now),
    hardGates: hardGatesStep(),
    verifyJudgements,
    rank,
    verifyExplanations,
    renderReport: (input) => buildReport(input, now()),
  };

  const modelSteps: ModelSteps = {
    extractPostings: extractStep(client),
    judge: judgeStep(client),
    explain: explainStep(client),
  };

  const effects = productionEffects({
    env,
    publisher: reportPublisherFromUrl(setting("REPORTS_URL"), credential),
    seen,
    seenJobs,
    applications: TableApplications.connect(tables, "applications", credential),
    fetch: fetchFn,
    now,
  });

  return { deterministicSteps, modelSteps, effects };
}
