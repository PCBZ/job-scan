import { describe, expect, it } from "vitest";
import type { ConnectMailbox } from "../../src/lib/mail/mailbox.js";
import { isPlaceholder, runFetch } from "../../src/lib/mail/run.js";
import { MemorySeenStore } from "../../src/lib/mail/seen-store.js";
import type { FetchPayload } from "../../src/lib/mail/types.js";
import { account, eml, FakeMailbox, LONG_PLAIN } from "./helpers.js";

const NOW = new Date("2026-10-03T15:00:00Z");
const ENV = {
  A_USER: "a@gmail.com",
  A_PASSWORD: "test-password-a",
  B_USER: "b@gmail.com",
  B_PASSWORD: "test-password-b",
};
const A = account({ name: "a", userEnv: "A_USER", passwordEnv: "A_PASSWORD" });
const B = account({ name: "b", userEnv: "B_USER", passwordEnv: "B_PASSWORD" });

function inbox(dates: (string | null)[], prefix: string) {
  return new FakeMailbox(
    new Map(
      dates.map((d, i) => [
        i + 1,
        eml({ messageId: `<${prefix}${i}@x>`, date: d, plain: LONG_PLAIN }),
      ]),
    ),
  );
}

describe("runFetch", () => {
  it("records a failing account and keeps going", async () => {
    const boxB = inbox(["Sat, 03 Oct 2026 08:00:00 -0700"], "b");
    const connect: ConnectMailbox = async (acct) => {
      if (acct.name === "a")
        throw Object.assign(new Error("AUTHENTICATIONFAILED"), { name: "AuthError" });
      return boxB;
    };
    const out = (await runFetch(
      { accounts: [A, B], maxTotalMessages: 150, days: 2 },
      { connect, seen: new MemorySeenStore(), env: ENV, now: NOW },
    )) as FetchPayload;
    expect(out.failures).toEqual([
      { account: "a", error: "AuthError", detail: "AUTHENTICATIONFAILED" },
    ]);
    expect(out.stats).toMatchObject({ accounts_scanned: 1, accounts_failed: 1, kept: 1 });
    expect(boxB.closed).toBe(true);
  });

  it("reports missing credentials without connecting", async () => {
    let connected = 0;
    const connect: ConnectMailbox = async () => {
      connected++;
      return inbox([], "x");
    };
    const out = await runFetch(
      { accounts: [A], maxTotalMessages: 150, days: 2 },
      {
        connect,
        seen: new MemorySeenStore(),
        env: { A_USER: "you@gmail.com", A_PASSWORD: "xxxxxxxxxxxxxxxx" },
        now: NOW,
      },
    );
    expect(connected).toBe(0);
    expect(out).toEqual({
      error: "all_accounts_failed",
      failures: [{ account: "a", error: "missing_credentials" }],
    });
  });

  it("closes the mailbox even when the fetch throws", async () => {
    const box = new FakeMailbox(new Map(), () => new Error("search down"));
    const out = await runFetch(
      { accounts: [A], maxTotalMessages: 150, days: 2 },
      { connect: async () => box, seen: new MemorySeenStore(), env: ENV, now: NOW },
    );
    expect(box.closed).toBe(true);
    expect(out).toMatchObject({ error: "all_accounts_failed" });
  });

  it("applies the whole-run budget newest first, undated last", async () => {
    const boxA = inbox(
      ["Fri, 02 Oct 2026 08:00:00 +0000", null, "Sat, 03 Oct 2026 09:00:00 +0000"],
      "a",
    );
    const boxB = inbox(["Sat, 03 Oct 2026 08:00:00 +0000"], "b");
    const out = (await runFetch(
      { accounts: [A, B], maxTotalMessages: 2, days: 2 },
      {
        connect: async (acct) => (acct.name === "a" ? boxA : boxB),
        seen: new MemorySeenStore(),
        env: ENV,
        now: NOW,
      },
    )) as FetchPayload;
    expect(out.messages.map((m) => m.message_id)).toEqual(["<a2@x>", "<b0@x>"]);
    expect(out.stats.dropped_for_budget).toBe(2);
    expect(out.stats.dropped_by_account).toEqual({ a: 2 });
    expect(out.stats.per_account.map((s) => [s.account, s.kept, s.kept_after_budget])).toEqual([
      ["a", 3, 1],
      ["b", 1, 1],
    ]);
  });
});

describe("isPlaceholder", () => {
  it.each([
    ["", true],
    ["  ", true],
    ["YOU@GMAIL.COM", true],
    ["xxxxxxxxxxxxxxxx", true],
    ["xxxx xxxx xxxx xxxx", false],
    ["real@gmail.com", false],
    [
      "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/gmail-main-password/)",
      true,
    ],
  ])("%j → %s", (value, expected) => {
    expect(isPlaceholder(value)).toBe(expected);
  });
});
