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

// A type alias, not an interface: the Tables SDK needs Record<string, unknown>.
type SeenEntity = {
  partitionKey: string;
  rowKey: string;
  messageId: string;
  seenOn: string;
};

/** RowKey can't hold / \ # ? or control characters, so hash the Message-ID. */
function rowKeyFor(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

/** Table `seenmessages`: PartitionKey = account, RowKey = SHA-256 of the Message-ID. */
export class TableSeenStore implements SeenStore {
  constructor(private readonly client: Pick<TableClient, "listEntities" | "submitTransaction">) {}

  static connect(tableEndpoint: string, tableName: string, credential: TokenCredential) {
    return new TableSeenStore(new TableClient(tableEndpoint, tableName, credential));
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
      // A transaction may touch each entity once; repeated Message-IDs (or
      // colliding no-id fallbacks) would otherwise fail the whole batch.
      const entities = new Map<string, SeenEntity>();
      for (const m of group) {
        const rowKey = rowKeyFor(m.message_id);
        entities.set(rowKey, {
          partitionKey: account,
          rowKey,
          messageId: m.message_id,
          seenOn: day,
        });
      }
      const unique = [...entities.values()];
      for (let i = 0; i < unique.length; i += 100) {
        const actions: TableTransaction["actions"] = unique
          .slice(i, i + 100)
          .map((entity) => ["upsert", entity]);
        await this.client.submitTransaction(actions);
      }
    }
  }
}
