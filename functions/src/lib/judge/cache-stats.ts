// What a run did with the judgement cache (#150), for its run record and the
// evaluation email.

export interface JudgementCacheStats {
  /** Answers reused: kept after verification, so the model wasn't asked. */
  reused: number;
  written: number;
  failed_reads: number;
  failed_writes: number;
  /** Request units Cosmos charged. */
  request_charge: number;
}

/** The counts behind the stats, which the cache adds to as it goes. */
export class JudgementCacheCounts {
  reused = 0;
  written = 0;
  failedReads = 0;
  failedWrites = 0;

  snapshot(requestCharge: number): JudgementCacheStats {
    return {
      reused: this.reused,
      written: this.written,
      failed_reads: this.failedReads,
      failed_writes: this.failedWrites,
      request_charge: Math.round(requestCharge * 100) / 100,
    };
  }
}
