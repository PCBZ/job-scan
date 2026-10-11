// The report every surface renders from: the HTML page (#19), the email (#20)
// and the Telegram message (#21). Plain data, already in reading order.

import type { Outcome } from "../workflow/types.js";

export interface TopPick {
  title: string;
  company: string;
  location: string;
  salary: string;
  /** An http(s) link to the posting, or "" when the alert gave none. */
  url: string;
  score: number;
  confidence: "high" | "medium" | "low";
  /** The resume to send. */
  variant: string;
  /** Another resume within 5 points: send either. */
  either: string | undefined;
  /** The mailbox it came through. */
  account: string;
  fit: { sentence: string; quote: string } | undefined;
  /** requirement is "" when the alert lists no requirement the resume misses. */
  gap: { requirement: string; advice: string } | undefined;
  unknown: string;
  /** Why the score was capped at 70. */
  caps: string[];
  /** What a gate switched off by a sentinel would have caught. */
  noted: string[];
}

export interface OtherPick {
  title: string;
  company: string;
  location: string;
  salary: string;
  url: string;
  score: number;
  /** The one thing to check: the judged gap, else the first unknown. */
  check: string;
}

export interface FilteredGroup {
  gate: string;
  items: { title: string; company: string; location: string; reason: string }[];
}

/** A flagged message, quoted in its own words. */
export interface SuspiciousItem {
  kind: "scam" | "payment" | "credentials" | "instruction";
  from: string;
  subject: string;
  reason: string;
  quote: string;
}

/**
 * "not checked" when no mail could be read. Otherwise the flags, and how many
 * messages went unchecked (their extraction failed), so an empty list only
 * reads as "Nothing" when every message was checked.
 */
export type SuspiciousSection = "not checked" | { items: SuspiciousItem[]; unchecked: number };

export interface Report {
  /** The run's day in Vancouver, YYYY-MM-DD. */
  day: string;
  outcome: Outcome;
  /** Mailboxes that failed to sync, as warnings at the top. */
  alerts: string[];
  /** The scanned-to-picked funnel, one line. */
  funnel: string;
  /** Repeats, duplicates and misaligned rows, one line or "". */
  counts: string;
  /** What a gate couldn't apply or compare, each said once. */
  notes: string[];
  top: TopPick[];
  others: OtherPick[];
  filtered: FilteredGroup[];
  suspicious: SuspiciousSection;
  housekeeping: string[];
}
