import type { TableClient, TransactionAction } from "@azure/data-tables";
import { describe, expect, it } from "vitest";
import { isPruneDay, TableSeenStore } from "../../src/lib/mail/seen-store.js";

class FakeTable {
  transactions: TransactionAction[][] = [];
  queries: { filter?: string; select?: string[] }[] = [];
  constructor(private readonly rows: Record<string, unknown>[] = []) {}
  async submitTransaction(actions: TransactionAction[]) {
    this.transactions.push(actions);
    return {} as never;
  }
  listEntities(options?: { queryOptions?: { filter?: string; select?: string[] } }) {
    this.queries.push(options?.queryOptions ?? {});
    const rows = this.rows;
    return (async function* () {
      yield* rows;
    })();
  }
}

function store(fake: FakeTable) {
  return new TableSeenStore(
    fake as unknown as Pick<TableClient, "listEntities" | "submitTransaction">,
  );
}

const rowKeys = (actions: TransactionAction[]) =>
  actions.map((a) => (a[1] as { rowKey: string }).rowKey);

describe("TableSeenStore.seenIds", () => {
  it("reads one account's Message-IDs seen on or after the cutoff", async () => {
    const fake = new FakeTable([{ messageId: "<1@x>" }, { messageId: "<2@x>" }]);
    expect(await store(fake).seenIds("gmail-main", "2026-07-11")).toEqual(
      new Set(["<1@x>", "<2@x>"]),
    );
    expect(fake.queries).toEqual([
      {
        filter: "PartitionKey eq 'gmail-main' and seenOn ge '2026-07-11'",
        select: ["messageId"],
      },
    ]);
  });
});

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

describe("TableSeenStore.pruneOlderThan", () => {
  it("finds rows seen before the cutoff across every account, keys only", async () => {
    const fake = new FakeTable();
    expect(await store(fake).pruneOlderThan("2026-07-11")).toBe(0);
    expect(fake.queries).toEqual([
      { filter: "seenOn lt '2026-07-11'", select: ["PartitionKey", "RowKey"] },
    ]);
    expect(fake.transactions).toEqual([]);
  });

  it("deletes them per account, at most 100 per transaction", async () => {
    const old = [
      ...Array.from({ length: 150 }, (_, i) => ({ partitionKey: "a", rowKey: `a${i}` })),
      { partitionKey: "dropped-account", rowKey: "d0" },
    ];
    const fake = new FakeTable(old);
    expect(await store(fake).pruneOlderThan("2026-07-11")).toBe(151);
    expect(fake.transactions.map((t) => t.length)).toEqual([100, 50, 1]);
    for (const t of fake.transactions) {
      expect(new Set(t.map((a) => a[0]))).toEqual(new Set(["delete"]));
      expect(new Set(t.map((a) => (a[1] as { partitionKey: string }).partitionKey)).size).toBe(1);
    }
    expect(fake.transactions[2]).toEqual([
      ["delete", { partitionKey: "dropped-account", rowKey: "d0" }],
    ]);
  });
});

describe("isPruneDay", () => {
  it("is Sunday only", () => {
    // 2026-10-11 is a Sunday.
    expect(["2026-10-10", "2026-10-11", "2026-10-12"].map(isPruneDay)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
