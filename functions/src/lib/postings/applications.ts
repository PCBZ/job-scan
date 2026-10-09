// Table `applications`: one row per recommended posting, keyed by fp16, the
// key in its Telegram buttons. The daily run adds a pending row; approving or
// skipping updates it (#25), and stale ones are archived (#27).

import { RestError, TableClient } from "@azure/data-tables";
import type { TokenCredential } from "@azure/identity";
import { fp16 } from "../fingerprint.js";
import type { Ranked } from "../judge/rank.js";

// A type alias, not an interface: the Tables SDK needs Record<string, unknown>.
type ApplicationEntity = {
  partitionKey: string;
  rowKey: string;
  status: "pending";
  recommendedOn: string;
  title: string;
  company: string;
  url: string;
  variant: string;
  score: number;
  account: string;
};

const PARTITION = "application";

export class TableApplications {
  constructor(private readonly client: Pick<TableClient, "createEntity">) {}

  static connect(tableEndpoint: string, tableName: string, credential: TokenCredential) {
    return new TableApplications(new TableClient(tableEndpoint, tableName, credential));
  }

  /** A pending row per pick; one that already exists keeps its status. */
  async addPending(top: Ranked[], day: string): Promise<void> {
    for (const pick of top) {
      const p = pick.posting;
      try {
        await this.client.createEntity<ApplicationEntity>({
          partitionKey: PARTITION,
          rowKey: fp16(p),
          status: "pending",
          recommendedOn: day,
          title: p.title,
          company: p.company,
          url: p.url,
          variant: pick.variant,
          score: pick.score,
          account: p.account,
        });
      } catch (err) {
        if (!(err instanceof RestError && err.statusCode === 409)) throw err;
      }
    }
  }
}
