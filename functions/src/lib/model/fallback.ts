// Try the primary model; if the provider itself failed, ask the fallback once.

import { type AppError, isAppError } from "../errors.js";
import type { ModelClient, StructuredRequest, StructuredResult } from "./types.js";

export class FallbackClient implements ModelClient {
  constructor(
    private readonly primary: ModelClient,
    private readonly fallback: ModelClient,
    /** Told why the fallback was used, for the run's warnings. */
    private readonly onFallback: (err: AppError<"model_provider">) => void = () => {},
  ) {}

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    try {
      return await this.primary.structured(req);
    } catch (err) {
      // Output problems (refusal, schema) would only be hidden by another model.
      if (!isAppError(err, "model_provider")) throw err;
      this.onFallback(err);
      return this.fallback.structured(req);
    }
  }
}
