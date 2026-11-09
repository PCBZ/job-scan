import { type ContainerClient, RestError } from "@azure/storage-blob";
import type { QueueClient } from "@azure/storage-queue";

/** The ContainerClient calls the handoff store makes, over blobs held here. */
export function fakePostingsContainer() {
  const blobs = new Map<string, Buffer>();
  const container = {
    getBlockBlobClient: (name: string) => ({
      upload: async (
        body: Buffer | string,
        _length: number,
        options?: { conditions?: { ifNoneMatch?: string } },
      ) => {
        if (options?.conditions?.ifNoneMatch === "*" && blobs.has(name))
          throw new RestError("BlobAlreadyExists", { statusCode: 409 });
        blobs.set(name, Buffer.from(body));
        return {};
      },
      downloadToBuffer: async () => {
        const blob = blobs.get(name);
        if (!blob) throw new RestError("BlobNotFound", { statusCode: 404 });
        return blob;
      },
    }),
    listBlobsFlat: async function* (options?: { prefix?: string }) {
      for (const name of [...blobs.keys()].sort())
        if (name.startsWith(options?.prefix ?? "")) yield { name };
    },
  };
  return { container: container as unknown as ContainerClient, blobs };
}

/** The QueueClient call the handoff queue makes, with the messages it was given. */
export function fakePostingsQueue() {
  const sent: { text: string; visibilityTimeout: number | undefined }[] = [];
  const queue = {
    sendMessage: async (text: string, options?: { visibilityTimeout?: number }) => {
      sent.push({ text, visibilityTimeout: options?.visibilityTimeout });
      return {};
    },
  };
  return { queue: queue as unknown as QueueClient, sent };
}
