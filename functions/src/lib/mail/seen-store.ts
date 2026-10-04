// Message-IDs already fetched, per account. Mirrors state["seen_messages"] in
// the local skill, which keys them "account|message-id".

import { createHash } from "node:crypto";
import { odata, TableClient, type TableTransaction } from "@azure/data-tables";
import type { TokenCredential } from "@azure/identity";

export interface SeenStore {
  /** Message-IDs already recorded for this account. */
  seenIds(account: string): Promise<Set<string>>;
  /** Record messages as seen on `day` (YYYY-MM-DD). */
  markSeen(messages: { account: string; message_id: string }[], day: string): Promise<void>;
}

export class MemorySeenStore implements SeenStore {
  private readonly ids = new Map<string, Set<string>>();

  async seenIds(account: string): Promise<Set<string>> {
    return new Set(this.ids.get(account) ?? []);
  }

  async markSeen(messages: { account: string; message_id: string }[]): Promise<void> {
    for (const m of messages) {
      const set = this.ids.get(m.account) ?? new Set<string>();
      set.add(m.message_id);
      this.ids.set(m.account, set);
    }
  }
}

interface SeenEntity {
  partitionKey: string;
  rowKey: string;
  messageId: string;
  seenOn: string;
}

/** RowKey can't hold / \ # ? or control characters, so hash the Message-ID. */
function rowKeyFor(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

/** Table `seenmessages`: PartitionKey = account, RowKey = SHA-256 of the Message-ID. */
export class TableSeenStore implements SeenStore {
  private readonly client: TableClient;

  constructor(tableEndpoint: string, tableName: string, credential: TokenCredential) {
    this.client = new TableClient(tableEndpoint, tableName, credential);
  }

  async seenIds(account: string): Promise<Set<string>> {
    const ids = new Set<string>();
    const entities = this.client.listEntities<SeenEntity>({
      queryOptions: { filter: odata`PartitionKey eq ${account}`, select: ["messageId"] },
    });
    for await (const entity of entities) ids.add(entity.messageId);
    return ids;
  }

  async markSeen(messages: { account: string; message_id: string }[], day: string): Promise<void> {
    // A transaction is limited to one partition and 100 operations.
    const byAccount = Map.groupBy(messages, (m) => m.account);
    for (const [account, group] of byAccount) {
      for (let i = 0; i < group.length; i += 100) {
        const actions: TableTransaction["actions"] = group.slice(i, i + 100).map((m) => [
          "upsert",
          {
            partitionKey: account,
            rowKey: rowKeyFor(m.message_id),
            messageId: m.message_id,
            seenOn: day,
          } satisfies SeenEntity,
        ]);
        await this.client.submitTransaction(actions);
      }
    }
  }
}
