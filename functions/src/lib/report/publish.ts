// Publish the HTML report to the private reports container and hand back a
// read-only link. The link is a user delegation SAS: signed with a key from
// the app's managed identity, never an account key (shared keys are off).

import type { TokenCredential } from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
} from "@azure/storage-blob";

/** A user delegation key lives at most seven days; stay inside that. */
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
/** Allow for clock skew between this host and Storage. */
const SKEW_MS = 5 * 60 * 1000;

type Service = Pick<
  BlobServiceClient,
  "getContainerClient" | "getUserDelegationKey" | "accountName"
>;

export interface ReportPublisher {
  /** Upload today's report and return a read-only HTTPS link valid for about 7 days. */
  publish(html: string, day: string): Promise<string>;
}

export function reportPublisher(
  service: Service,
  containerName: string,
  now: () => Date = () => new Date(),
): ReportPublisher {
  return {
    async publish(html, day) {
      const blobName = `${day}.html`;
      const blob = service.getContainerClient(containerName).getBlockBlobClient(blobName);
      await blob.upload(html, Buffer.byteLength(html), {
        blobHTTPHeaders: { blobContentType: "text/html; charset=utf-8" },
      });
      const t = now().getTime();
      const startsOn = new Date(t - SKEW_MS);
      const expiresOn = new Date(t + LIFETIME_MS);
      const key = await service.getUserDelegationKey(startsOn, expiresOn);
      const sas = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse("r"),
          protocol: SASProtocol.Https,
          startsOn,
          expiresOn,
        },
        key,
        service.accountName,
      );
      return `${blob.url}?${sas.toString()}`;
    },
  };
}

/** From REPORTS_URL, the container's endpoint, e.g. https://acct.blob.core.windows.net/reports. */
export function reportPublisherFromUrl(
  containerUrl: string,
  credential: TokenCredential,
): ReportPublisher {
  const url = new URL(containerUrl);
  const containerName = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!containerName || containerName.includes("/")) {
    throw new Error(`REPORTS_URL must be a container URL, got "${containerUrl}"`);
  }
  return reportPublisher(new BlobServiceClient(url.origin, credential), containerName);
}
