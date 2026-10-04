// The IMAP surface the fetch needs, so tests can use a fake. The real one is
// read-only twice over: the folder is opened with EXAMINE, and imapflow
// fetches message source with BODY.PEEK[], so \Seen is never set.

import { ImapFlow, type SearchObject } from "imapflow";
import type { MailAccount } from "./types.js";

export interface SearchQuery {
  since: Date;
  /** Match any of these in From. Empty means no sender filter. */
  from: string[];
}

export interface Mailbox {
  /** Opens `folder` read-only. */
  open(folder: string): Promise<void>;
  /** Matching UIDs in ascending order. */
  search(query: SearchQuery): Promise<number[]>;
  /** Raw RFC 822 source, or null when the server returns nothing. */
  fetchSource(uid: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export type ConnectMailbox = (
  account: MailAccount,
  user: string,
  password: string,
) => Promise<Mailbox>;

export function toImapSearch(query: SearchQuery): SearchObject {
  const from = query.from.map((s) => s.replaceAll('"', ""));
  if (from.length === 0) return { since: query.since };
  if (from.length === 1) return { since: query.since, from: from[0] };
  return { since: query.since, or: from.map((f) => ({ from: f })) };
}

export const connectImap: ConnectMailbox = async (account, user, password) => {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
  });
  await client.connect();
  return {
    async open(folder) {
      await client.mailboxOpen(folder, { readOnly: true });
    },
    async search(query) {
      const uids = await client.search(toImapSearch(query), { uid: true });
      if (!uids) throw new Error("IMAP SEARCH failed");
      return [...uids].sort((a, b) => a - b);
    },
    async fetchSource(uid) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return msg && msg.source !== undefined ? new Uint8Array(msg.source) : null;
    },
    async close() {
      await client.logout();
    },
  };
};
