// Registers OpenTelemetry before anything it traces loads.
import "../telemetry.js";
import { app, type InvocationContext } from "@azure/functions";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { z } from "zod";
import { composePipeline, type Pipeline } from "../lib/run/compose.js";
import { runCollect } from "../lib/run/collect.js";
import type { HandoffMessage } from "../lib/run/handoff.js";
import { loadSecrets, secretClientFromEnv } from "../lib/run/secrets.js";

type Env = Record<string, string | undefined>;

const messageSchema = z.object({
  day: z.string(),
  source: z.string(),
  blob: z.string(),
  first_seen: z.string(),
});

/**
 * The rest of the pipeline, from the message a source queued once its
 * postings were written. The queue retries a failure, five times in all
 * (host.json), but a failed run is claimed, so a retry does nothing: its mail
 * is reported again tomorrow. Dependencies and the credential are parameters,
 * so a test can pass its own.
 */
export function collectHandler(
  make: (env: Env, credential: TokenCredential) => Pipeline = composePipeline,
) {
  return async (
    queueEntry: unknown,
    context: InvocationContext,
    credential: TokenCredential = new DefaultAzureCredential(),
  ): Promise<void> => {
    const message: HandoffMessage = messageSchema.parse(queueEntry);
    const { env, missing } = await loadSecrets(
      process.env,
      secretClientFromEnv(process.env, credential),
    );
    if (missing.length) context.warn(`collect: not in Key Vault, so unset: ${missing.join(", ")}`);
    await runCollect(make(env, credential), message, context);
  };
}

app.storageQueue("collect", {
  queueName: "postings-ready",
  // PostingsQueue__queueServiceUri, __credential and __clientId: the app's identity.
  connection: "PostingsQueue",
  handler: collectHandler(),
});
