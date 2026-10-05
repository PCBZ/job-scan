import type { TableClient, TransactionAction } from "@azure/data-tables";
import { describe, expect, it } from "vitest";
import { TableSeenStore } from "../../src/lib/mail/seen-store.js";

class FakeTable {
  transactions: TransactionAction[][] = [];
  async submitTransaction(actions: TransactionAction[]) {
    this.transactions.push(actions);
    return {} as never;
  }
  listEntities() {
    return (async function* () {})();
  }
}

function store(fake: FakeTable) {
  return new TableSeenStore(
    fake as unknown as Pick<TableClient, "listEntities" | "submitTransaction">,
  );
}

const rowKeys = (actions: TransactionAction[]) =>
  actions.map((a) => (a[1] as { rowKey: string }).rowKey);

describe("TableSeenStore.markSeen", () => {
  it("writes each Message-ID once per transaction", async () => {
    const fake = new FakeTable();
    await store(fake).markSeen(
      [
        { account: "a", message_id: "<1@x>" },
        { account: "a", message_id: "<1@x>" },
        { account: "a", message_id: "<2@x>" },
      ],
      "2026-10-04",
    );
    expect(fake.transactions).toHaveLength(1);
    const keys = rowKeys(fake.transactions[0] ?? []);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps accounts in separate transactions and caps each at 100", async () => {
    const fake = new FakeTable();
    const many = Array.from({ length: 150 }, (_, i) => ({ account: "a", message_id: `<${i}@x>` }));
    await store(fake).markSeen([...many, { account: "b", message_id: "<1@x>" }], "2026-10-04");
    expect(fake.transactions.map((t) => t.length)).toEqual([100, 50, 1]);
  });
});
