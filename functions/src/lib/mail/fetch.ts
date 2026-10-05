// Fetch one account. Mirrors fetch() in scripts/fetch_mail.py.

import type { Mailbox } from "./mailbox.js";
import { processMessage } from "./message.js";
import type { AccountStats, FetchedMessage, MailAccount } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function fetchAccount(
  mailbox: Mailbox,
  account: MailAccount,
  days: number,
  seenIds: ReadonlySet<string>,
  now: Date,
): Promise<{ messages: FetchedMessage[]; stats: AccountStats }> {
  await mailbox.open(account.folder);

  const since = new Date(now.getTime() - days * DAY_MS);
  let uids: number[];
  try {
    uids = await mailbox.search({ since, from: account.senders });
  } catch {
    // Some servers reject long OR chains; fall back to the date alone and let
    // the per-message filters do the work.
    uids = await mailbox.search({ since, from: [] });
  }
  // Newest last: keep the most recent max_messages.
  uids = uids.slice(-account.maxMessages);

  const messages: FetchedMessage[] = [];
  let alreadySeen = 0;
  let filteredOut = 0;
  for (const uid of uids) {
    const source = await mailbox.fetchSource(uid);
    if (!source) continue;
    const outcome = await processMessage(source, account, seenIds);
    if (outcome.kind === "seen") alreadySeen++;
    else if (outcome.kind === "filtered") filteredOut++;
    else messages.push(outcome.message);
  }

  const fromHtml = messages.filter((m) => m.body_source === "html").length;
  return {
    messages,
    stats: {
      account: account.name,
      candidates: uids.length,
      already_seen: alreadySeen,
      filtered_out: filteredOut,
      kept: messages.length,
      body_from_plain: messages.length - fromHtml,
      body_from_html: fromHtml,
    },
  };
}
