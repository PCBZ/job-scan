// The cloud's view of [resume]: which repository and ref to read, and which
// files count as variants. Mirrors workspace.resume_config(), with the GitHub
// repository standing in for the local `lib` directory.

import { ConfigError } from "./error.js";
import type { RawResume } from "./schema.js";

export interface ResumeConfig {
  owner: string;
  repo: string;
  ref: string;
  /** Globs relative to the repository root, e.g. "General/*.tex". */
  variants: string[];
  /** Variant name to prefer, without extension. */
  default: string | null;
}

export function resumeConfig(raw: RawResume | undefined, origin: string): ResumeConfig {
  const resume = raw ?? {};
  if (!resume.repo) {
    throw new ConfigError(
      `[resume] repo is not set in ${origin}. The cloud run reads resumes from GitHub; ` +
        'set it to the repository that holds them, e.g. repo = "owner/name".',
    );
  }
  const [owner, repo] = resume.repo.split("/") as [string, string];
  return {
    owner,
    repo,
    ref: resume.ref ?? "main",
    variants: resume.variants?.length ? resume.variants : ["*.tex", "*.pdf", "*.md", "*.txt"],
    default: resume.default || null,
  };
}
