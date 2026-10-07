// Postings already recommended, by fingerprint. Mirrors state["seen_jobs"] in
// the local skill: only recommended postings are recorded (seen_jobs.py add
// < recommended.json), so a posting passed over today can still come back.

import { odata, RestError, TableClient } from "@azure/data-tables";
import type { TokenCredential } from "@azure/identity";
import { fingerprint, type JobIdentity } from "../fingerprint.js";

// A type alias, not an interface: the Tables SDK needs Record<string, unknown>.
type SeenJobEntity = {
  partitionKey: string;
  rowKey: string;
  firstSeen: string;
  lastSeen: string;
  title: string;
  company: string;
};

const PARTITION = "job";

/**
 * Table `seenjobs`: one partition, RowKey = the fingerprint. A fingerprint is
 * only [a-z0-9 ] and "|", all legal in a RowKey, so it is stored as is and
 * reads plainly in the portal.
 */
export class TableSeenJobsStore {
  constructor(
    private readonly client: Pick<TableClient, "listEntities" | "createEntity" | "updateEntity">,
  ) {}

  static connect(tableEndpoint: string, tableName: string, credential: TokenCredential) {
    return new TableSeenJobsStore(new TableClient(tableEndpoint, tableName, credential));
  }

  /** Fingerprints recommended on or after `since` (YYYY-MM-DD). */
  async recommendedSince(since: string): Promise<Set<string>> {
    const fps = new Set<string>();
    const entities = this.client.listEntities<SeenJobEntity>({
      queryOptions: {
        filter: odata`PartitionKey eq ${PARTITION} and lastSeen ge ${since}`,
        select: ["rowKey"],
      },
    });
    for await (const e of entities) fps.add(e.rowKey);
    return fps;
  }

  /** Record postings as recommended on `day`, keeping each one's first day. */
  async recordRecommended(jobs: JobIdentity[], day: string): Promise<void> {
    // A handful of top picks a day: one write each is simpler than a batch.
    // Once per fingerprint: two picks can share one.
    for (const [rowKey, job] of new Map(jobs.map((j) => [fingerprint(j), j]))) {
      const update = {
        partitionKey: PARTITION,
        rowKey,
        lastSeen: day,
        title: job.title ?? "",
        company: job.company ?? "",
      };
      try {
        await this.client.createEntity<SeenJobEntity>({ ...update, firstSeen: day });
      } catch (err) {
        // Recommended before: keep its firstSeen, move lastSeen.
        if (!(err instanceof RestError && err.statusCode === 409)) throw err;
        await this.client.updateEntity(update, "Merge");
      }
    }
  }
}
