import type { BlobServiceClient, UserDelegationKey } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import { reportPublisher, reportPublisherFromUrl } from "../../src/lib/report/publish.js";

const NOW = new Date("2026-10-08T15:00:00Z");

/** The BlobServiceClient calls the publisher makes, recorded. */
function fakeService() {
  const uploads: { name: string; body: string; length: number; contentType: string | undefined }[] =
    [];
  const keyWindows: [Date, Date][] = [];
  const service = {
    accountName: "jobscanacct",
    getContainerClient: (container: string) => ({
      getBlockBlobClient: (name: string) => ({
        url: `https://jobscanacct.blob.core.windows.net/${container}/${name}`,
        upload: async (
          body: string,
          length: number,
          options: { blobHTTPHeaders?: { blobContentType?: string } },
        ) => {
          uploads.push({
            name,
            body,
            length,
            contentType: options.blobHTTPHeaders?.blobContentType,
          });
          return {};
        },
      }),
    }),
    getUserDelegationKey: async (startsOn: Date, expiresOn: Date): Promise<UserDelegationKey> => {
      keyWindows.push([startsOn, expiresOn]);
      return {
        signedObjectId: "oid",
        signedTenantId: "tid",
        signedStartsOn: startsOn,
        signedExpiresOn: expiresOn,
        signedService: "b",
        signedVersion: "2025-01-05",
        value: Buffer.from("not-a-real-key").toString("base64"),
      };
    },
  };
  return { service: service as unknown as BlobServiceClient, uploads, keyWindows };
}

describe("reportPublisher", () => {
  it("uploads the day's HTML and returns a read-only HTTPS link to that blob", async () => {
    const { service, uploads } = fakeService();
    const url = new URL(
      await reportPublisher(service, "reports", () => NOW).publish("<p>é</p>", "2026-10-08"),
    );

    expect(uploads).toEqual([
      {
        name: "2026-10-08.html",
        body: "<p>é</p>",
        length: 9,
        contentType: "text/html; charset=utf-8",
      },
    ]);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://jobscanacct.blob.core.windows.net/reports/2026-10-08.html",
    );
    const q = url.searchParams;
    expect([q.get("sp"), q.get("spr"), q.get("sr")]).toEqual(["r", "https", "b"]);
    // Signed with a user delegation key: its identity is in the SAS, no account key.
    expect([q.get("skoid"), q.get("sktid")]).toEqual(["oid", "tid"]);
    expect(q.get("sig")).toBeTruthy();
  });

  it("is valid from just before now to just under seven days, the key's limit", async () => {
    const { service, keyWindows } = fakeService();
    const url = new URL(
      await reportPublisher(service, "reports", () => NOW).publish("x", "2026-10-08"),
    );
    const [start, end] = keyWindows[0] ?? [];
    expect(start?.toISOString()).toBe("2026-10-08T14:55:00.000Z");
    expect(end?.toISOString()).toBe("2026-10-15T14:55:00.000Z");
    expect(end && end.getTime() - NOW.getTime()).toBeLessThan(7 * 24 * 3600 * 1000);
    expect(url.searchParams.get("se")).toBe("2026-10-15T14:55:00Z");
  });
});

describe("reportPublisherFromUrl", () => {
  it("needs a container URL", () => {
    const credential = { getToken: async () => null };
    expect(() => reportPublisherFromUrl("https://acct.blob.core.windows.net/", credential)).toThrow(
      "container URL",
    );
    expect(() =>
      reportPublisherFromUrl("https://acct.blob.core.windows.net/a/b", credential),
    ).toThrow("container URL");
    expect(() =>
      reportPublisherFromUrl("https://acct.blob.core.windows.net/reports", credential),
    ).not.toThrow();
  });
});
