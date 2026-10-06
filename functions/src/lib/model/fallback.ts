// Try the primary model; if the provider itself failed, ask the fallback once.

import {
  type ModelClient,
  ModelProviderError,
  type StructuredRequest,
  type StructuredResult,
} from "./types.js";

export class FallbackClient implements ModelClient {
  constructor(
    private readonly primary: ModelClient,
    private readonly fallback: ModelClient,
    /** Told why the fallback was used, for the run's warnings. */
    private readonly onFallback: (err: ModelProviderError) => void = () => {},
  ) {}

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    try {
      return await this.primary.structured(req);
    } catch (err) {
      // Output problems (refusal, schema) would only be hidden by another model.
      if (!(err instanceof ModelProviderError)) throw err;
      this.onFallback(err);
      return this.fallback.structured(req);
    }
  }
}
