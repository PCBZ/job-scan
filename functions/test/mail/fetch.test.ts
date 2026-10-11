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
  it("opens the folder, searches the window for senders or keywords, keeps the newest", async () => {
    const box = new FakeMailbox(messages(5));
    const { messages: got, stats } = await fetchAccount(
      box,
      account({ folder: "Job Alerts", maxMessages: 3, subjectKeywords: ["hiring"] }),
      2,
      new Set(["<m4@example.com>"]),
      NOW,
    );
    expect(box.opened).toEqual(["Job Alerts"]);
    expect(box.searches).toEqual([
      {
        since: new Date("2026-10-01T15:00:00Z"),
        from: ["linkedin.com", "indeed.com"],
        subject: ["hiring"],
      },
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

  it("falls back to a date-only search, and still keeps only senders or keywords", async () => {
    const mail = new Map([
      [1, eml({ messageId: "<a@x>", plain: LONG_PLAIN })],
      [
        2,
        eml({
          messageId: "<b@x>",
          from: "news@contoso.example",
          subject: "Newsletter",
          plain: LONG_PLAIN,
        }),
      ],
      [
        3,
        eml({
          messageId: "<c@x>",
          from: "dana@fabrikam.example",
          subject: "We're hiring",
          plain: LONG_PLAIN,
        }),
      ],
    ]);
    const box = new FakeMailbox(mail, (q) =>
      q.from.length || q.subject.length ? new Error("BAD") : null,
    );
    const { messages: got, stats } = await fetchAccount(
      box,
      account({ subjectKeywords: ["hiring"] }),
      2,
      new Set(),
      NOW,
    );
    expect(box.searches.map(({ from, subject }) => ({ from, subject }))).toEqual([
      { from: ["linkedin.com", "indeed.com"], subject: ["hiring"] },
      { from: [], subject: [] },
    ]);
    // The date-only window has the newsletter too; the rule drops it.
    expect(got.map((m) => m.message_id)).toEqual(["<a@x>", "<c@x>"]);
    expect(stats).toMatchObject({ candidates: 3, filtered_out: 1, kept: 2 });
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
    expect(toImapSearch({ since, from: [], subject: [] })).toEqual({ since });
  });
  it("uses one FROM for a single sender", () => {
    expect(toImapSearch({ since, from: ["linkedin.com"], subject: [] })).toEqual({
      since,
      from: "linkedin.com",
    });
  });
  it("ORs several senders and strips quotes", () => {
    expect(toImapSearch({ since, from: ['a"b.com', "indeed.com"], subject: [] })).toEqual({
      since,
      or: [{ from: "ab.com" }, { from: "indeed.com" }],
    });
  });
  it("uses one SUBJECT for a single keyword", () => {
    expect(toImapSearch({ since, from: [], subject: ["招聘"] })).toEqual({
      since,
      subject: "招聘",
    });
  });
  it("ORs senders with subject keywords", () => {
    expect(
      toImapSearch({ since, from: ["linkedin.com"], subject: ["hiring", 'say "hi"'] }),
    ).toEqual({
      since,
      or: [{ from: "linkedin.com" }, { subject: "hiring" }, { subject: "say hi" }],
    });
  });
});
