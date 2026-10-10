// Fetch every configured account. Mirrors the fetch half of main() in
// scripts/fetch_mail.py: one failing mailbox never sinks the run, and a
// whole-run budget keeps the newest messages.

import { codePointLength } from "../unicode.js";
import { fetchAccount } from "./fetch.js";
import type { ConnectMailbox } from "./mailbox.js";
import type { SeenStore } from "./seen-store.js";
import type {
  AccountFailure,
  AccountStats,
  AllAccountsFailed,
  FetchedMessage,
  FetchPayload,
  MailRunConfig,
} from "./types.js";

const PLACEHOLDER_USERS = new Set([
  "you@gmail.com",
  "you@example.com",
  "your@email.com",
  "other@gmail.com",
  "you@university.edu",
  "you@outlook.com",
]);

/**
 * True for empty values, the untouched ones shipped in .env.example, and a Key
 * Vault reference the platform couldn't resolve: it then passes the reference
 * through as the value, which would fail as a confusing login error.
 */
export function isPlaceholder(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return true;
  if (v.startsWith("@microsoft.keyvault(")) return true;
  if (PLACEHOLDER_USERS.has(v)) return true;
  // A run of x's stands in for the 16-character app password.
  return [...v].every((c) => c === "x");
}

export interface RunDeps {
  connect: ConnectMailbox;
  seen: SeenStore;
  env: Record<string, string | undefined>;
  now: Date;
}

export async function runFetch(
  config: MailRunConfig,
  deps: RunDeps,
): Promise<FetchPayload | AllAccountsFailed> {
  let messages: FetchedMessage[] = [];
  const perAccount: AccountStats[] = [];
  const failures: AccountFailure[] = [];

  for (const account of config.accounts) {
    const user = deps.env[account.userEnv];
    const password = deps.env[account.passwordEnv];
    if (isPlaceholder(user) || isPlaceholder(password)) {
      failures.push({ account: account.name, error: "missing_credentials" });
      continue;
    }
    try {
      const mailbox = await deps.connect(account, user as string, password as string);
      try {
        const seenIds = await deps.seen.seenIds(account.name);
        const got = await fetchAccount(mailbox, account, config.days, seenIds, deps.now);
        messages.push(...got.messages);
        perAccount.push(got.stats);
      } finally {
        await mailbox.close().catch(() => {});
      }
    } catch (err) {
      // One bad mailbox must not sink the run.
      const e = err instanceof Error ? err : new Error(String(err));
      failures.push({ account: account.name, error: e.name, detail: e.message.slice(0, 300) });
    }
  }

  if (perAccount.length === 0) return { error: "all_accounts_failed", failures };

  // Whole-run ceiling, newest first; undated mail sorts last.
  const budget = config.maxTotalMessages;
  const droppedByAccount: Record<string, number> = {};
  if (messages.length > budget) {
    messages = messages.toSorted((a, b) => {
      if (Boolean(a.date) !== Boolean(b.date)) return a.date ? -1 : 1;
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
    for (const m of messages.slice(budget)) {
      droppedByAccount[m.account] = (droppedByAccount[m.account] ?? 0) + 1;
    }
    messages = messages.slice(0, budget);
  }
  for (const stats of perAccount) {
    stats.kept_after_budget = messages.filter((m) => m.account === stats.account).length;
  }

  const sum = (pick: (s: AccountStats) => number) => perAccount.reduce((n, s) => n + pick(s), 0);
  return {
    fetched_at: deps.now.toISOString(),
    window_days: config.days,
    stats: {
      accounts_scanned: perAccount.length,
      accounts_failed: failures.length,
      kept: messages.length,
      already_seen: sum((s) => s.already_seen),
      filtered_out: sum((s) => s.filtered_out),
      total_chars: messages.reduce((n, m) => n + codePointLength(m.body), 0),
      body_from_plain: messages.filter((m) => m.body_source === "plain").length,
      body_from_html: messages.filter((m) => m.body_source === "html").length,
      budget,
      dropped_for_budget: Object.values(droppedByAccount).reduce((n, c) => n + c, 0),
      dropped_by_account: droppedByAccount,
      per_account: perAccount,
    },
    failures,
    messages,
  };
}
