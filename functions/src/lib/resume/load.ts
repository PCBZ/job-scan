// Resume variants as plain text, ready to match against postings.
//
// Extracted text is cached by a hash of the source, so an unchanged variant
// is never re-extracted. Each successful load also records which text each
// variant had; when GitHub can't be read, that last good set is used and the
// run carries a warning instead of failing. With no good set yet, the set is
// empty and the run reports that nothing was scored.

import { createHash } from "node:crypto";
import type { ResumeConfig } from "../config/resume.js";
import { latexToText } from "./latex.js";
import type { ResumeSource } from "./source.js";
import type { TextStore } from "./store.js";
import { normalizeResumeText } from "./text.js";
import { discoverVariants, pickDefault, variantName } from "./variants.js";

/** Bump when extraction output changes, so cached texts are rebuilt. */
export const EXTRACTOR_VERSION = "v1";

export interface ResumeVariant {
  path: string;
  name: string;
  text: string;
}

export interface ResumeSet {
  variants: ResumeVariant[];
  /** Path of the variant to prefer. */
  defaultPath: string;
  /** For the report: skipped files, or the GitHub failure behind a fallback. */
  warnings: string[];
  /** True when GitHub couldn't be read and the last good texts were used. */
  stale: boolean;
  /** Texts produced this run, as opposed to taken from the cache. */
  extracted: number;
}

interface IndexFile {
  saved_at: string;
  variants: { path: string; text: string }[];
}

export type Extract = (path: string, source: string) => string;

/** LaTeX is converted; Markdown and text are only normalised. */
function modeOf(path: string): "tex" | "plain" {
  return path.toLowerCase().endsWith(".tex") ? "tex" : "plain";
}

/** resume_text.extract for the formats the cloud reads: LaTeX, Markdown, text. */
export const extractText: Extract = (path, source) =>
  normalizeResumeText(modeOf(path) === "tex" ? latexToText(source) : source);

/** By source hash and mode: identical bytes in a .md and a .tex extract differently. */
function textKey(path: string, source: string): string {
  const hash = createHash("sha256").update(source).digest("hex");
  return `text/${EXTRACTOR_VERSION}/${modeOf(path)}/${hash}.txt`;
}

function indexKey(cfg: ResumeConfig): string {
  return `index/${cfg.owner}/${cfg.repo}/${cfg.ref}.json`;
}

function toSet(
  cfg: ResumeConfig,
  variants: ResumeVariant[],
): Pick<ResumeSet, "variants" | "defaultPath"> {
  const paths = variants.map((v) => v.path);
  return { variants, defaultPath: pickDefault(paths, cfg.default) ?? (paths[0] as string) };
}

export async function loadResumes(
  cfg: ResumeConfig,
  source: ResumeSource,
  store: TextStore,
  now: Date,
  extract: Extract = extractText,
): Promise<ResumeSet> {
  const warnings: string[] = [];

  // Only reading GitHub falls back. An extraction bug or a storage failure
  // below must surface as itself, not as a stale set blamed on GitHub.
  const sources: { path: string; raw: string }[] = [];
  try {
    for (const path of await discoverVariants(source, cfg.variants)) {
      if (path.toLowerCase().endsWith(".pdf")) {
        warnings.push(
          `Skipped ${path}: PDF resumes aren't read in the cloud; keep a .tex or .md variant.`,
        );
        continue;
      }
      sources.push({ path, raw: await source.readFile(path) });
    }
  } catch (err) {
    return fallback(cfg, store, err);
  }
  if (sources.length === 0) throw new Error("every resume variant was skipped");

  const fresh: { variant: ResumeVariant; key: string }[] = [];
  let extracted = 0;
  for (const { path, raw } of sources) {
    const key = textKey(path, raw);
    let text = await store.get(key);
    if (text === null) {
      text = extract(path, raw);
      await store.put(key, text);
      extracted++;
    }
    fresh.push({ variant: { path, name: variantName(path), text }, key });
  }

  const index: IndexFile = {
    saved_at: now.toISOString(),
    variants: fresh.map((f) => ({ path: f.variant.path, text: f.key })),
  };
  await store.put(indexKey(cfg), JSON.stringify(index));
  const variants = fresh.map((f) => f.variant);
  return { ...toSet(cfg, variants), warnings, stale: false, extracted };
}

async function fallback(cfg: ResumeConfig, store: TextStore, cause: unknown): Promise<ResumeSet> {
  const reason = cause instanceof Error ? cause.message : String(cause);
  // No good set yet (a first run): an empty set, so the run still reports why.
  const none = (detail: string): ResumeSet => ({
    variants: [],
    defaultPath: "",
    warnings: [`Couldn't read resumes from GitHub (${reason.slice(0, 200)}); ${detail}.`],
    stale: false,
    extracted: 0,
  });
  const raw = await store.get(indexKey(cfg));
  if (raw === null) return none("no earlier versions are cached");
  const index = JSON.parse(raw) as IndexFile;
  const variants: ResumeVariant[] = [];
  for (const v of index.variants) {
    const text = await store.get(v.text);
    if (text === null) return none("the cached versions are incomplete");
    variants.push({ path: v.path, name: variantName(v.path), text });
  }
  return {
    ...toSet(cfg, variants),
    warnings: [
      `Couldn't read resumes from GitHub (${reason.slice(0, 200)}); using the versions from ${index.saved_at}.`,
    ],
    stale: true,
    extracted: 0,
  };
}
