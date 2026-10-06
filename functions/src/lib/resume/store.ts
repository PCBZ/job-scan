// Named text objects: the resume-cache container in Azure, a Map in tests.

import type { TokenCredential } from "@azure/identity";
import { ContainerClient, RestError } from "@azure/storage-blob";

export interface TextStore {
  /** The object's text, or null when it doesn't exist. */
  get(name: string): Promise<string | null>;
  put(name: string, text: string): Promise<void>;
}

export class MemoryTextStore implements TextStore {
  readonly objects = new Map<string, string>();

  async get(name: string) {
    return this.objects.get(name) ?? null;
  }

  async put(name: string, text: string) {
    this.objects.set(name, text);
  }
}

export function blobTextStore(containerUrl: string, credential: TokenCredential): TextStore {
  const container = new ContainerClient(containerUrl, credential);
  return {
    async get(name) {
      try {
        return (await container.getBlockBlobClient(name).downloadToBuffer()).toString("utf8");
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) return null;
        throw err;
      }
    },
    async put(name, text) {
      const body = Buffer.from(text, "utf8");
      await container.getBlockBlobClient(name).upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
      });
    },
  };
}
