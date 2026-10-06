// Port of discover(), variant_name() and pick_default() in
// scripts/resume_text.py, over a ResumeSource instead of the local disk.
// Variants come back sorted by path: a repository has no file mtimes, so the
// local skill's newest-first order isn't available.

import { type DirEntry, ResumeNotFoundError, type ResumeSource } from "./source.js";

export const SUPPORTED = [".tex", ".pdf", ".md", ".markdown", ".txt"];

/** Files a resume library carries that are not themselves resumes. */
const NOT_A_VARIANT = new Set(["preamble", "macros", "commands", "styles", "header", "config"]);

const WILDCARD = /[*?[]/;

/** One path segment of a glob, translated the way Python's fnmatch does. */
export function segmentPattern(segment: string): RegExp {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
      } else {
        let set = segment.slice(i + 1, end).replaceAll("\\", "\\\\");
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        out += `[${set}]`;
        i = end;
      }
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "s");
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function variantName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A directory's entries, or none when it doesn't exist (glob.glob's behaviour). */
async function entriesOf(source: ResumeSource, dir: string): Promise<DirEntry[]> {
  try {
    return await source.listDir(dir);
  } catch (err) {
    if (err instanceof ResumeNotFoundError) return [];
    throw err;
  }
}

/**
 * Every variant matching `globs`, relative to the repository root. Only the
 * last segment may contain wildcards ("General/*.tex"); like glob.glob, a
 * wildcard doesn't match names that start with a dot, a missing directory
 * matches nothing, and a literal path counts only if the file exists.
 *
 * Finding nothing is an error: GitHub reports a repository the token can't
 * see as 404 too, so an empty result is as likely a credential problem as an
 * empty library, and there is nothing to score either way.
 */
export async function discoverVariants(source: ResumeSource, globs: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const glob of globs) {
    const parts = glob.split("/").filter((p) => p !== "" && p !== ".");
    const last = parts.pop();
    if (!last) continue;
    if (parts.some((p) => WILDCARD.test(p))) {
      throw new Error(
        `unsupported resume glob "${glob}": wildcards are allowed in the file name only`,
      );
    }
    const dir = parts.join("/");
    const entries = await entriesOf(source, dir);
    if (!WILDCARD.test(last)) {
      const hit = entries.find((e) => e.type === "file" && e.name === last);
      if (hit) found.add(hit.path);
      continue;
    }
    const pattern = segmentPattern(last);
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      if (entry.name.startsWith(".") && !last.startsWith(".")) continue;
      if (pattern.test(entry.name)) found.add(entry.path);
    }
  }
  const variants = [...found]
    .filter((path) => {
      const name = variantName(path).toLowerCase();
      return !NOT_A_VARIANT.has(name) && SUPPORTED.includes(extension(path));
    })
    .sort();
  if (variants.length === 0) {
    throw new Error(
      `no resume variants match ${JSON.stringify(globs)}. Check [resume] repo, ref and ` +
        "variants, and that the GitHub token can read the repository.",
    );
  }
  return variants;
}

/** The configured default, else a conventional name, else the first variant. */
export function pickDefault(variants: string[], wanted: string | null): string | null {
  if (wanted) {
    const target = wanted.toLowerCase().replace(/\.[^.]*$/, "");
    const hit = variants.find((p) => variantName(p).toLowerCase() === target);
    if (hit) return hit;
  }
  const conventional = variants.find((p) =>
    ["resume", "cv", "main"].includes(variantName(p).toLowerCase()),
  );
  return conventional ?? variants[0] ?? null;
}
