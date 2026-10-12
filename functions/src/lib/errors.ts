// Errors by how the caller handles them (#83): one Error, told apart by a
// code, instead of a class per module. Every kind the app throws is listed in
// ErrorCode; a caller that branches checks the code with isAppError.

export type ErrorCode =
  /** Missing or invalid configuration, in config.toml or an app setting. The run stops. */
  | "config"
  /** A resume path GitHub says doesn't exist; a missing directory is just empty. */
  | "resume_not_found"
  /**
   * The model answered, but not usably: a refusal, truncation, a content filter,
   * or output that fails its schema. That message's rows are dropped; another
   * model would only hide a prompt or schema problem, so no fallback.
   */
  | "model_output"
  /** The provider failed (rate limit, outage, network, auth); a fallback may take it. */
  | "model_provider"
  /** The Bot API refused a call. */
  | "telegram"
  /** Jev failed in a way a later run may not: rate limit, outage, timeout, network. */
  | "decision_provider"
  /** The request to Jev is wrong; retrying won't help. */
  | "decision_request";

/** The fields a code carries, beside the message. */
interface Fields {
  model_provider: { status: number | undefined };
  /** retryAfter: seconds to wait, when Telegram rate-limits the bot. */
  telegram: { status: number; retryAfter: number | undefined };
  decision_provider: { status: number | undefined };
  decision_request: { status: number | undefined };
}

type FieldsOf<C extends ErrorCode> = C extends keyof Fields ? Fields[C] : unknown;

export type AppError<C extends ErrorCode = ErrorCode> = Error & {
  readonly code: C;
} & Readonly<FieldsOf<C>>;

/** A code with fields takes them (and an optional cause); the rest take only a cause. */
type Extra<C extends ErrorCode> = C extends keyof Fields
  ? [extra: Fields[C] & ErrorOptions]
  : [extra?: ErrorOptions];

/** An Error with `code`; its name is the code too, so logs read "config: …". */
export function appError<C extends ErrorCode>(
  code: C,
  message: string,
  ...[extra]: Extra<C>
): AppError<C> {
  const { cause, ...fields } = (extra ?? {}) as ErrorOptions & Record<string, unknown>;
  const err = new Error(message, extra && "cause" in extra ? { cause } : undefined);
  return Object.assign(err, { name: code, code, ...fields }) as unknown as AppError<C>;
}

/** Whether `err` is an AppError with this code; narrows to its fields. */
export function isAppError<C extends ErrorCode>(err: unknown, code: C): err is AppError<C> {
  return err instanceof Error && (err as { code?: unknown }).code === code;
}
