import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "openai";

/**
 * The only module that holds the OpenAI client. Server and worker code only.
 *
 * SDK automatic retries are disabled: a retried image request after a timeout
 * can be billed twice. Callers decide explicitly whether a failure is safe to
 * retry using `classifyProviderError`.
 */

export class ProviderNotConfiguredError extends Error {
  readonly code = "not_configured";
  constructor() {
    super("OPENAI_API_KEY is not set. Add it to server/.env and restart the FrameFlow server.");
    this.name = "ProviderNotConfiguredError";
  }
}

let client: OpenAI | undefined;
let clientKey: string | undefined;

export function getOpenAI(key: string | undefined): OpenAI {
  if (!key) throw new ProviderNotConfiguredError();
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 10 * 60 * 1000 });
    clientKey = key;
  }
  return client;
}

export type ProviderErrorCode =
  | "not_configured"
  | "auth"
  | "model_unavailable"
  | "rate_limited"
  | "quota_exceeded"
  | "invalid_request"
  | "content_policy"
  | "timeout"
  | "network"
  | "server"
  | "aborted"
  | "unknown";

export interface ClassifiedProviderError {
  code: ProviderErrorCode;
  /** Safe, actionable message for the UI. Never contains the API key. */
  message: string;
  /**
   * True only when the request certainly did not start billable work
   * (e.g. rejected before processing). Timeouts are NOT retryable for paid calls.
   */
  safeToRetry: boolean;
  /** The provider may have done (and billed) work even though we got no result. */
  outcomeUnknown: boolean;
  status?: number;
  requestId?: string | null;
  /** Provider's raw message for the diagnostics panel. */
  detail?: string;
}

export function classifyProviderError(err: unknown, context: { model?: string } = {}): ClassifiedProviderError {
  const model = context.model ? ` "${context.model}"` : "";
  if (err instanceof ProviderNotConfiguredError) {
    return { code: "not_configured", message: err.message, safeToRetry: false, outcomeUnknown: false };
  }
  if (err instanceof APIUserAbortError) {
    return { code: "aborted", message: "The request was cancelled.", safeToRetry: false, outcomeUnknown: true };
  }
  // Timeout must be checked before the generic connection error (subclass).
  if (err instanceof APIConnectionTimeoutError) {
    return {
      code: "timeout",
      message: "The provider did not respond in time. The request may still have been processed and billed, so it was not retried automatically.",
      safeToRetry: false,
      outcomeUnknown: true,
    };
  }
  if (err instanceof APIConnectionError) {
    return {
      code: "network",
      message: "Could not reach the OpenAI API. Check your network connection.",
      safeToRetry: false,
      outcomeUnknown: true,
      detail: err.message,
    };
  }
  if (err instanceof APIError) {
    const base = { status: err.status, requestId: err.requestID, detail: err.message };
    if (err instanceof AuthenticationError) {
      return { ...base, code: "auth", message: "The OpenAI API key was rejected. Check OPENAI_API_KEY.", safeToRetry: false, outcomeUnknown: false };
    }
    if (err instanceof NotFoundError || (err instanceof PermissionDeniedError && /model/i.test(err.message))) {
      return {
        ...base,
        code: "model_unavailable",
        message: `Model${model} is not available to this API key. Choose a model your account can access in .env.`,
        safeToRetry: false,
        outcomeUnknown: false,
      };
    }
    if (err instanceof PermissionDeniedError) {
      return { ...base, code: "auth", message: "This API key is not permitted to make this request.", safeToRetry: false, outcomeUnknown: false };
    }
    if (err instanceof RateLimitError) {
      const quota = err.code === "insufficient_quota" || /quota|billing/i.test(err.message);
      return quota
        ? { ...base, code: "quota_exceeded", message: "The OpenAI account has no remaining quota or billing is not set up.", safeToRetry: false, outcomeUnknown: false }
        : { ...base, code: "rate_limited", message: "Rate limited by OpenAI. Wait a moment and try again.", safeToRetry: true, outcomeUnknown: false };
    }
    if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
      const policy = err.code === "content_policy_violation" || /safety|content policy|moderation/i.test(err.message);
      return policy
        ? { ...base, code: "content_policy", message: "The request was declined by the provider's safety system. Adjust the inputs and try again.", safeToRetry: false, outcomeUnknown: false }
        : { ...base, code: "invalid_request", message: `The provider rejected the request parameters${err.param ? ` (${err.param})` : ""}.`, safeToRetry: false, outcomeUnknown: false };
    }
    if (typeof err.status === "number" && err.status >= 500) {
      return { ...base, code: "server", message: "OpenAI returned a server error. The request may have been partially processed.", safeToRetry: false, outcomeUnknown: true };
    }
    return { ...base, code: "unknown", message: "The provider returned an unexpected error.", safeToRetry: false, outcomeUnknown: true };
  }
  return {
    code: "unknown",
    message: "Unexpected error while calling the provider.",
    safeToRetry: false,
    outcomeUnknown: true,
    detail: err instanceof Error ? err.message : String(err),
  };
}

export interface ModelAccessResult {
  role: string;
  model: string;
  ok: boolean;
  error?: ClassifiedProviderError;
}

/**
 * Verify configured models are visible to this key via the (unbilled) models
 * endpoint. Visibility does not prove every parameter is supported.
 */
export async function checkModelAccess(key: string | undefined, models: Record<string, string>): Promise<ModelAccessResult[]> {
  const openai = getOpenAI(key);
  return Promise.all(
    Object.entries(models).map(async ([role, model]) => {
      try {
        await openai.models.retrieve(model, { timeout: 20_000 });
        return { role, model, ok: true };
      } catch (err) {
        return { role, model, ok: false, error: classifyProviderError(err, { model }) };
      }
    }),
  );
}
