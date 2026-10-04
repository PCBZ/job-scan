// Port of scripts/mail_text.py: turning email parts into the text and links
// the model reads. Pure string in, string out. tests/fixtures/mail_text.json
// holds the Python results these must reproduce. html_to_text follows the
// Python stdlib path (bs4 is not installed there).
//
// decode_header_value and message_body work on parsed email objects and
// arrive with the IMAP port.

import { decodeHTML } from "entities";
import {
  PY_NON_SPACE as NS,
  pyCompare,
  pyLen,
  pySlice,
  pyStrip,
  PY_SPACE as S,
} from "./python-re.js";

const TRACKING_PARAMS =
  /[?&](utm_[a-z]+|trk|trkEmail|midToken|midSig|eid|ct|lipi|refId|_ga)=[^&]*/giu;

// text/plain has no hyperlinks, so senders inline full tracking URLs as text
// and wrap them across lines. extractLinks() keeps the URLs.
const URL_INLINE = new RegExp(`(?:https?://|www\\.)${NS}+`, "giu");
const URL_FRAGMENT = new RegExp(`^${NS}{28,}$`, "u");

const HIDDEN_BLOCKS = /<(script|style|head)[\s\S]*?<\/\1>/giu;
const LINE_BREAKS = new RegExp(`<br${S}*/?>|</p>|</div>|</tr>|</li>|</td>`, "giu");
const TAGS = /<[^>]+>/gu;

export function htmlToText(html: string): string {
  let text = html.replace(HIDDEN_BLOCKS, " ");
  text = text.replace(LINE_BREAKS, "\n");
  text = text.replace(TAGS, " ");
  // Full entity table: alerts are dense with &middot; and &bull; separators.
  return decodeHTML(text);
}

/** Drop inlined URLs and their wrapped continuations. */
export function stripInlineUrls(text: string): string {
  return text
    .replace(URL_INLINE, " ")
    .split("\n")
    .filter((line) => {
      const bare = pyStrip(line);
      // A wrapped continuation is one long token with URL punctuation.
      return !(URL_FRAGMENT.test(bare) && /[?&=/%]/.test(bare));
    })
    .join("\n");
}

const BLANK_RUN = new RegExp(`\\n${S}*\\n${S}*\\n+`, "gu");

/** Normalise whitespace, drop inlined URLs, enforce the size cap. */
export function cleanText(text: string, maxChars: number): string {
  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = stripInlineUrls(out);
  out = out.replace(/[ \t\xa0]+/g, " ");
  out = out.replace(BLANK_RUN, "\n\n");
  out = out
    .split("\n")
    .map(pyStrip)
    .filter((line) => line !== "")
    .join("\n");
  if (pyLen(out) > maxChars) {
    out = `${pySlice(out, maxChars)}\n[...truncated]`;
  }
  return out;
}

/**
 * Path plus surviving query params, sorted. Path alone collapsed whole boards:
 * Indeed puts the job id in ?jk= and Glassdoor in ?jl=.
 */
export function dedupeKey(url: string): string {
  const at = url.indexOf("?");
  if (at === -1) return url;
  const base = url.slice(0, at);
  const query = url.slice(at + 1);
  if (query === "") return base;
  const params = query.split("&").filter((p) => p !== "");
  return `${base}?${params.sort(pyCompare).join("&")}`;
}

export interface Link {
  text: string;
  url: string;
}

const ANCHOR = new RegExp(`<a${S}[^>]*href=["']([^"']+)["'][^>]*>([\\s\\S]*?)</a>`, "giu");
const SPACE_RUN = new RegExp(`${S}+`, "gu");

/** (anchor text, url) pairs, de-tracked and deduped, in order. */
export function extractLinks(html: string, limit = 60): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(ANCHOR)) {
    const rawUrl = match[1] ?? "";
    const rawLabel = match[2] ?? "";
    if (!rawUrl.toLowerCase().startsWith("http")) continue;
    const url = rawUrl.replace(TRACKING_PARAMS, "").replace(/[?&]+$/u, "");
    const label = pyStrip(rawLabel.replace(TAGS, " ").replace(SPACE_RUN, " "));
    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text: pySlice(label, 120), url });
    if (links.length >= limit) break;
  }
  return links;
}
