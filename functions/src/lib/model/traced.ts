// A span per model call (#101), on OpenTelemetry's GenAI conventions so the
// portal shows it as a model dependency: the deployment, tokens, status and
// repair round. No prompt or answer: the run records keep the content.

import { inSpan } from "../telemetry/tracing.js";
import type { ModelClient, StructuredRequest, StructuredResult } from "./types.js";

export class TracedClient implements ModelClient {
  constructor(
    private readonly inner: ModelClient,
    private readonly system: string,
    /** The deployment name on Azure, the model id elsewhere. */
    private readonly model: string,
    private readonly label: string,
  ) {}

  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return inSpan(
      `chat ${this.model}`,
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": this.system,
        "gen_ai.request.model": this.model,
        "job_scan.schema": req.name,
        "job_scan.slot": this.label,
        "job_scan.repair_round": req.repairs?.length ?? 0,
      },
      async (span) => {
        const result = await this.inner.structured(req);
        span.setAttributes({
          "gen_ai.usage.input_tokens": result.usage.input,
          "gen_ai.usage.output_tokens": result.usage.output,
        });
        return result;
      },
    );
  }
}
