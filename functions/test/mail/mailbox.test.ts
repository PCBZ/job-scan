import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type ImapClient, imapConnector } from "../../src/lib/mail/mailbox.js";
import { account } from "./helpers.js";

/** Just enough of ImapFlow, as an EventEmitter like the real one. */
class FakeImapFlow extends EventEmitter {
  calls: string[] = [];
  async connect() {
    this.calls.push("connect");
  }
  async mailboxOpen(folder: string, opts: { readOnly?: boolean }) {
    this.calls.push(`open ${folder} readOnly=${opts.readOnly}`);
  }
  async search() {
    return [3, 1, 2];
  }
  async fetchOne() {
    return { source: Buffer.from("raw") };
  }
  async logout() {
    this.calls.push("logout");
  }
}

function connector(fake: FakeImapFlow) {
  return imapConnector(() => fake as unknown as ImapClient);
}

describe("imapConnector", () => {
  it("opens read-only, sorts UIDs and returns raw bytes", async () => {
    const fake = new FakeImapFlow();
    const box = await connector(fake)(account(), "u", "p");
    await box.open("INBOX");
    expect(await box.search({ since: new Date(), from: [] })).toEqual([1, 2, 3]);
    expect(await box.fetchSource(1)).toEqual(new Uint8Array(Buffer.from("raw")));
    await box.close();
    expect(fake.calls).toEqual(["connect", "open INBOX readOnly=true", "logout"]);
  });

  it("turns a post-connect error event into a rejected call instead of a crash", async () => {
    const fake = new FakeImapFlow();
    const box = await connector(fake)(account(), "u", "p");
    // With no listener, EventEmitter would throw this synchronously.
    expect(() => fake.emit("error", new Error("ECONNRESET"))).not.toThrow();
    await expect(box.open("INBOX")).rejects.toThrow("ECONNRESET");
    await box.close();
    expect(fake.calls).toEqual(["connect"]);
  });
});
