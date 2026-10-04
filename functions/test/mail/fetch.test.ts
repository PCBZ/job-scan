import { describe, expect, it } from "vitest";
import { fetchAccount } from "../../src/lib/mail/fetch.js";
import { toImapSearch } from "../../src/lib/mail/mailbox.js";
import { account, eml, FakeMailbox, LONG_PLAIN } from "./helpers.js";

const NOW = new Date("2026-10-03T15:00:00Z");

function messages(count: number) {
  return new Map(
    Array.from({ length: count }, (_, i) => [
      i + 1,
      eml({ messageId: `<m${i + 1}@example.com>`, plain: LONG_PLAIN }),
    ]),
  );
}

describe("fetchAccount", () => {
  it("opens the folder, searches the window with the sender allowlist, keeps the newest", async () => {
    const box = new FakeMailbox(messages(5));
    const { messages: got, stats } = await fetchAccount(
      box,
      account({ folder: "Job Alerts", maxMessages: 3 }),
      2,
      new Set(["<m4@example.com>"]),
      NOW,
    );
    expect(box.opened).toEqual(["Job Alerts"]);
    expect(box.searches).toEqual([
      { since: new Date("2026-10-01T15:00:00Z"), from: ["linkedin.com", "indeed.com"] },
    ]);
    expect(box.fetched).toEqual([3, 4, 5]);
    expect(got.map((m) => m.message_id)).toEqual(["<m3@example.com>", "<m5@example.com>"]);
    expect(stats).toEqual({
      account: "gmail-main",
      candidates: 3,
      already_seen: 1,
      filtered_out: 0,
      kept: 2,
      body_from_plain: 2,
      body_from_html: 0,
    });
  });

  it("falls back to a date-only search when the sender search fails", async () => {
    const box = new FakeMailbox(messages(1), (q) => (q.from.length ? new Error("BAD") : null));
    const { stats } = await fetchAccount(box, account(), 2, new Set(), NOW);
    expect(box.searches.map((q) => q.from)).toEqual([["linkedin.com", "indeed.com"], []]);
    expect(stats.kept).toBe(1);
  });

  it("skips messages the server returns no source for", async () => {
    const box = new FakeMailbox(new Map([[1, null]]));
    const { stats } = await fetchAccount(box, account(), 2, new Set(), NOW);
    expect(stats).toMatchObject({ candidates: 1, kept: 0, filtered_out: 0 });
  });
});

describe("toImapSearch", () => {
  const since = new Date("2026-10-01T00:00:00Z");
  it("uses SINCE alone without senders", () => {
    expect(toImapSearch({ since, from: [] })).toEqual({ since });
  });
  it("uses one FROM for a single sender", () => {
    expect(toImapSearch({ since, from: ["linkedin.com"] })).toEqual({
      since,
      from: "linkedin.com",
    });
  });
  it("ORs several senders and strips quotes", () => {
    expect(toImapSearch({ since, from: ['a"b.com', "indeed.com"] })).toEqual({
      since,
      or: [{ from: "ab.com" }, { from: "indeed.com" }],
    });
  });
});
