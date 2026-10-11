// Message-IDs already fetched, per account. Mirrors state["seen_messages"] in
// the local skill, which keys them "account|message-id".

import { createHash } from "node:crypto";
import { odata, TableClient, type TableTransaction } from "@azure/data-tables";
import type { TokenCredential } from "@azure/identity";

/**
 * How long a Message-ID stays seen, as in the local skill
 * (workspace.SEEN_MESSAGE_DAYS). Table Storage has no TTL, so the daily run
 * prunes older rows. It must exceed the lookback window ([mail] days), or seen
 * mail would come back as new; the config load checks that.
 */
export const SEEN_MESSAGE_DAYS = 90;

export interface SeenStore {
  /** Message-IDs recorded for this account on or after `since` (YYYY-MM-DD). */
  seenIds(account: string, since: string): Promise<Set<string>>;
  /** Record messages as seen on `day` (YYYY-MM-DD). */
  markSeen(messages: { account: string; message_id: string }[], day: string): Promise<void>;
  /** Forget every account's messages seen before `cutoff` (YYYY-MM-DD). Returns how many. */
  pruneOlderThan(cutoff: string): Promise<number>;
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

  async seenIds(account: string, since: string): Promise<Set<string>> {
    const ids = new Set<string>();
    // Bounded by the retention even when a prune failed. seenOn is YYYY-MM-DD,
    // so string order is date order.
    const entities = this.client.listEntities<SeenEntity>({
      queryOptions: {
        filter: odata`PartitionKey eq ${account} and seenOn ge ${since}`,
        select: ["messageId"],
      },
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

  async pruneOlderThan(cutoff: string): Promise<number> {
    // Across the table, not per configured account: an account dropped from
    // the config leaves rows behind too.
    const old = this.client.listEntities<{ partitionKey: string; rowKey: string }>({
      queryOptions: { filter: odata`seenOn lt ${cutoff}`, select: ["PartitionKey", "RowKey"] },
    });
    const byAccount = new Map<string, string[]>();
    for await (const e of old) {
      const rows = byAccount.get(e.partitionKey) ?? [];
      rows.push(e.rowKey);
      byAccount.set(e.partitionKey, rows);
    }
    let pruned = 0;
    // As in markSeen: one partition and at most 100 operations per transaction.
    for (const [partitionKey, rowKeys] of byAccount) {
      for (let i = 0; i < rowKeys.length; i += 100) {
        const actions: TableTransaction["actions"] = rowKeys
          .slice(i, i + 100)
          .map((rowKey) => ["delete", { partitionKey, rowKey }]);
        await this.client.submitTransaction(actions);
        pruned += actions.length;
      }
    }
    return pruned;
  }
}
