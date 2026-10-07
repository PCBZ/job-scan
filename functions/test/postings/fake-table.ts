import { RestError, type TableClient } from "@azure/data-tables";
import { TableSeenJobsStore } from "../../src/lib/postings/seen-jobs.js";

type Entity = Record<string, unknown>;

/** The TableClient calls TableSeenJobsStore makes; listEntities returns every row. */
export class FakeTable {
  readonly rows = new Map<string, Entity>();
  readonly calls: string[] = [];
  filters: string[] = [];
  fail?: Error;

  listEntities(options: { queryOptions: { filter: string } }) {
    this.filters.push(options.queryOptions.filter);
    const rows = [...this.rows.values()];
    return (async function* () {
      yield* rows;
    })();
  }
  async createEntity(e: Entity) {
    this.calls.push(`create ${e.rowKey}`);
    if (this.fail) throw this.fail;
    if (this.rows.has(e.rowKey as string)) {
      throw new RestError("The specified entity already exists.", { statusCode: 409 });
    }
    this.rows.set(e.rowKey as string, e);
    return {} as never;
  }
  async updateEntity(e: Entity, mode: string) {
    this.calls.push(`update ${e.rowKey} ${mode}`);
    const prev = this.rows.get(e.rowKey as string) ?? {};
    this.rows.set(e.rowKey as string, { ...prev, ...e });
    return {} as never;
  }
}

export const store = (fake: FakeTable) =>
  new TableSeenJobsStore(
    fake as unknown as Pick<TableClient, "listEntities" | "createEntity" | "updateEntity">,
  );
