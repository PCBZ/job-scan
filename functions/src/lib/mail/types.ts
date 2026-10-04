// Shapes for the mail fetch, ported from scripts/fetch_mail.py. Message and
// payload fields keep the Python JSON names so both runs can be compared.

import type { Link } from "../mail-text.js";

/** One mailbox, fully populated (provider presets and [mail] defaults applied). */
export interface MailAccount {
  name: string;
  host: string;
  port: number;
  folder: string;
  senders: string[];
  subjectKeywords: string[];
  excludeSenders: string[];
  maxMessages: number;
  maxCharsPerMessage: number;
  /** Environment variables holding this account's credentials. */
  userEnv: string;
  passwordEnv: string;
}

export interface MailRunConfig {
  accounts: MailAccount[];
  /** Whole-run ceiling across accounts, newest first. */
  maxTotalMessages: number;
  /** Lookback window for IMAP SINCE. */
  days: number;
}

export interface FetchedMessage {
  account: string;
  message_id: string;
  from: string;
  subject: string;
  /** ISO 8601 in UTC, or "" when the Date header is missing or unparseable. */
  date: string;
  body: string;
  body_source: "plain" | "html";
  links: Link[];
}

export interface AccountStats {
  account: string;
  candidates: number;
  already_seen: number;
  filtered_out: number;
  kept: number;
  body_from_plain: number;
  body_from_html: number;
  kept_after_budget?: number;
}

export interface AccountFailure {
  account: string;
  error: string;
  detail?: string;
}

export interface FetchPayload {
  fetched_at: string;
  window_days: number;
  stats: {
    accounts_scanned: number;
    accounts_failed: number;
    kept: number;
    already_seen: number;
    filtered_out: number;
    total_chars: number;
    body_from_plain: number;
    body_from_html: number;
    budget: number;
    dropped_for_budget: number;
    dropped_by_account: Record<string, number>;
    per_account: AccountStats[];
  };
  failures: AccountFailure[];
  messages: FetchedMessage[];
}

export interface AllAccountsFailed {
  error: "all_accounts_failed";
  failures: AccountFailure[];
}
