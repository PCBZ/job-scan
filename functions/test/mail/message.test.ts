import { describe, expect, it } from "vitest";
import { messageIdOf, processMessage } from "../../src/lib/mail/message.js";
import { account, eml, LONG_PLAIN } from "./helpers.js";

const none = new Set<string>();

describe("processMessage", () => {
  it("decodes RFC 2047 sender and subject", async () => {
    const out = await processMessage(
      eml({
        from: "=?UTF-8?B?Sm9iIEFsZXJ0cyDwn5qA?= <alerts@linkedin.com>",
        subject: "=?UTF-8?Q?3_new_jobs_=E2=80=94_backend?=",
        plain: LONG_PLAIN,
      }),
      account(),
      none,
    );
    expect(out.kind).toBe("kept");
    if (out.kind !== "kept") return;
    expect(out.message.from).toBe("Job Alerts 🚀 <alerts@linkedin.com>");
    expect(out.message.subject).toBe("3 new jobs — backend");
    expect(out.message.date).toBe("2026-10-03T15:15:00.000Z");
  });

  it("unfolds a folded Subject header (Python keeps the CRLF)", async () => {
    const out = await processMessage(
      eml({ subject: "3 new jobs for\r\n Senior Backend Engineer", plain: LONG_PLAIN }),
      account(),
      none,
    );
    if (out.kind !== "kept") throw new Error(out.kind);
    expect(out.message.subject).toBe("3 new jobs for Senior Backend Engineer");
  });

  it("skips a Message-ID already seen for the account", async () => {
    const out = await processMessage(
      eml({ plain: LONG_PLAIN }),
      account(),
      new Set(["<m1@example.com>"]),
    );
    expect(out).toEqual({ kind: "seen" });
  });

  it("falls back to raw Date and Subject when Message-ID is missing", () => {
    expect(
      messageIdOf([
        { key: "date", value: "Sat, 03 Oct 2026 08:15:00 -0700" },
        { key: "subject", value: "=?UTF-8?Q?Jobs?=" },
      ]),
    ).toBe("no-id:Sat, 03 Oct 2026 08:15:00 -0700:=?UTF-8?Q?Jobs?=");
  });

  it("drops excluded senders", async () => {
    const out = await processMessage(
      eml({ plain: LONG_PLAIN }),
      account({ excludeSenders: ["JOBALERTS-NOREPLY"] }),
      none,
    );
    expect(out).toEqual({ kind: "filtered" });
  });

  it("applies subject keywords only to senders not on the allowlist", async () => {
    const acct = account({ senders: ["linkedin.com"], subjectKeywords: ["engineer"] });
    const allowlisted = await processMessage(
      eml({ subject: "Weekly digest", plain: LONG_PLAIN }),
      acct,
      none,
    );
    const otherNoKeyword = await processMessage(
      eml({ from: "careers@example.org", subject: "Newsletter", plain: LONG_PLAIN }),
      acct,
      none,
    );
    const otherWithKeyword = await processMessage(
      eml({ from: "careers@example.org", subject: "Backend Engineer role", plain: LONG_PLAIN }),
      acct,
      none,
    );
    expect(allowlisted.kind).toBe("kept");
    expect(otherNoKeyword).toEqual({ kind: "filtered" });
    expect(otherWithKeyword.kind).toBe("kept");
  });

  it("uses the plain body when it has more than 200 characters", async () => {
    const out = await processMessage(
      eml({ plain: LONG_PLAIN, html: '<a href="https://example.com/j?id=1">Job</a>' }),
      account(),
      none,
    );
    if (out.kind !== "kept") throw new Error(out.kind);
    expect(out.message.body_source).toBe("plain");
    expect(out.message.links).toEqual([{ text: "Job", url: "https://example.com/j?id=1" }]);
  });

  it("renders HTML when the plain body is a stub", async () => {
    const out = await processMessage(
      eml({
        plain: "View in browser",
        html: '<style>p{}</style><p>Senior Backend Engineer</p><p>Northwind &middot; Vancouver, BC</p><a href="https://example.com/j?id=2">Apply</a>',
      }),
      account(),
      none,
    );
    if (out.kind !== "kept") throw new Error(out.kind);
    expect(out.message.body_source).toBe("html");
    expect(out.message.body).toBe("Senior Backend Engineer\nNorthwind · Vancouver, BC\nApply");
  });

  it("drops bodies shorter than 40 characters", async () => {
    const out = await processMessage(eml({ plain: "Too short to be an alert" }), account(), none);
    expect(out).toEqual({ kind: "filtered" });
  });

  it("leaves date empty when the Date header is missing", async () => {
    const out = await processMessage(eml({ date: null, plain: LONG_PLAIN }), account(), none);
    if (out.kind !== "kept") throw new Error(out.kind);
    expect(out.message.date).toBe("");
  });
});
