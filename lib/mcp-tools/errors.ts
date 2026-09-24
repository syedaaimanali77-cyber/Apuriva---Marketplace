/**
 * Spec 036 §3 "Errors" — turning whatever a tool call threw into the outcome the model receives.
 *
 * A domain error passes through UNCHANGED: its `code`, `message` and `details` are the domain's own
 * (e.g. spec 020's `SLOT_NO_LONGER_AVAILABLE` with its alternatives, spec 018's `OFFER_EXPIRED`).
 * Spec 035's pipeline codes pass through unchanged too. MCP classification is ADDITIVE — the
 * outcome's `status` and `retryable` — and never replaces a code: there is no wrapper code.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type { AiActionOutcome } from '@/lib/ai-assistant/executor';

/** The MCP-specific contract error (spec 036 D-14), kept distinct from spec 004's `VALIDATION_ERROR`. */
export const MCP_IDEMPOTENCY_KEY_REQUIRED = 'MCP_IDEMPOTENCY_KEY_REQUIRED';

/**
 * Thrown by a state-changing tool invoked without a server-issued key. It is carried to spec 034 as
 * a structured `failed` outcome, never emitted as an HTTP response, so it is deliberately NOT an
 * `ApiRouteError` and has no HTTP status (spec 036 §3). The domain function is never called.
 */
export class McpIdempotencyKeyRequiredError extends Error {
  readonly code = MCP_IDEMPOTENCY_KEY_REQUIRED;

  constructor(toolName: string) {
    super(`The action "${toolName}" could not run without its server-issued idempotency key.`);
    this.name = 'McpIdempotencyKeyRequiredError';
  }
}

/** Spec 004's own wording for an unexpected failure — `withApiRoute` uses the same text. */
const UNEXPECTED_FAILURE_MESSAGE = 'An unexpected error occurred.';

export function toOutcome(err: unknown): Exclude<AiActionOutcome, { status: 'succeeded' }> {
  if (err instanceof ApiRouteError) {
    const details: Record<string, unknown> = { ...(err.details ?? {}) };
    if (err.errors) details.errors = err.errors;
    return {
      status: 'failed',
      error: {
        code: err.code,
        message: err.message,
        ...(Object.keys(details).length > 0 ? { details } : {}),
        retryable: false,
      },
    };
  }
  if (err instanceof McpIdempotencyKeyRequiredError) {
    return { status: 'failed', error: { code: err.code, message: err.message, retryable: false } };
  }
  return { status: 'unknown', error: { code: 'INTERNAL_ERROR', message: UNEXPECTED_FAILURE_MESSAGE, retryable: false } };
}
