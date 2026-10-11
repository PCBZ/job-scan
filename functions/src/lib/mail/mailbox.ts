// The IMAP surface the fetch needs, so tests can use a fake. The real one is
// read-only twice over: the folder is opened with EXAMINE, and imapflow
// fetches message source with BODY.PEEK[], so \Seen is never set.

import { ImapFlow, type SearchObject } from "imapflow";
import type { MailAccount } from "./types.js";

export interface SearchQuery {
  since: Date;
  /** Match any of these in From, or any of `subject` in Subject. Both empty means the window alone. */
  from: string[];
  subject: string[];
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

/** The server-side half of passesFilter: any sender, or any keyword. Mirrors search_terms. */
export function searchTerms(query: Pick<SearchQuery, "from" | "subject">): [string, string][] {
  return [
    ...query.from.map((s): [string, string] => ["from", s.replaceAll('"', "")]),
    ...query.subject.map((k): [string, string] => ["subject", k.replaceAll('"', "")]),
  ];
}

// imapflow picks CHARSET UTF-8 itself when a term needs it ("招聘").
export function toImapSearch(query: SearchQuery): SearchObject {
  const terms = searchTerms(query).map(([key, value]) => ({ [key]: value }));
  if (terms.length === 0) return { since: query.since };
  if (terms.length === 1) return { since: query.since, ...terms[0] };
  return { since: query.since, or: terms };
}

/** The parts of ImapFlow the adapter uses, so tests can supply a fake client. */
export type ImapClient = Pick<
  ImapFlow,
  "connect" | "mailboxOpen" | "search" | "fetchOne" | "logout" | "on"
>;

export type CreateImapClient = (account: MailAccount, user: string, password: string) => ImapClient;

const createImapFlow: CreateImapClient = (account, user, password) =>
  new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
  });

export function imapConnector(create: CreateImapClient = createImapFlow): ConnectMailbox {
  return async (account, user, password) => {
    const client = create(account, user, password);
    // ImapFlow emits "error" when the connection fails after connect().
    // Unhandled, that event would crash the process; instead the next call
    // throws it, and runFetch records it as this account's failure.
    let failure: Error | undefined;
    client.on("error", (err: Error) => {
      failure = err;
    });
    const live = () => {
      if (failure) throw failure;
    };
    await client.connect();
    return {
      async open(folder) {
        live();
        await client.mailboxOpen(folder, { readOnly: true });
      },
      async search(query) {
        live();
        const uids = await client.search(toImapSearch(query), { uid: true });
        if (!uids) throw new Error("IMAP SEARCH failed");
        return [...uids].sort((a, b) => a - b);
      },
      async fetchSource(uid) {
        live();
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        return msg && msg.source !== undefined ? new Uint8Array(msg.source) : null;
      },
      async close() {
        if (!failure) await client.logout();
      },
    };
  };
}

export const connectImap: ConnectMailbox = imapConnector();
