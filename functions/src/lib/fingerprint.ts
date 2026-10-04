// Port of normalize() / fingerprint() in scripts/seen_jobs.py. Both must give
// identical output; tests/fixtures/fingerprints.json holds Python's results.
//
// Python's `re` is Unicode-aware for str patterns, JavaScript's is ASCII by
// default, so its classes are spelled out here:
//   \w → [\p{L}\p{N}_]    \d → \p{Nd}    \s → Python's str.isspace() set
//   \b → lookarounds on \w    re.I → the `iu` flags (Unicode case folding)

const W = String.raw`[\p{L}\p{N}_]`;
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const S = String.raw`[\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　]`;
const D = String.raw`\p{Nd}`;

// Suffixes and decorations that differ between job boards but mean the same role.
const NOISE = new RegExp(
  `${B}(?:inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|` +
    `group|holdings|the)${B}|[^a-z0-9 ]`,
  "giu",
);

const REQ_ID = new RegExp(
  `(?:${B}(?:job${S}*id|req(?:uisition)?(?:${S}*id)?|posting${S}*id|job|id)${B}${S}*[-:.#]*${S}*` +
    `|#${S}*)[a-z]*${D}{3,}[a-z0-9-]*`,
  "giu",
);

const SPACE_RUN = new RegExp(`${S}+`, "gu");

export function normalize(value: string | null | undefined): string {
  let v = (value ?? "").toLowerCase();
  v = v.replace(REQ_ID, " ");
  v = v.replace(NOISE, " ");
  return v.replace(SPACE_RUN, " ").replace(new RegExp(`^${S}+|${S}+$`, "gu"), "");
}

export interface JobIdentity {
  company?: string | null;
  title?: string | null;
}

export function fingerprint(job: JobIdentity): string {
  return `${normalize(job.company)}|${normalize(job.title)}`;
}
