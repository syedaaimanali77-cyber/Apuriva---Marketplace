/**
 * Spec 036 §3 "Retry policy" (D-9, AC-6).
 *
 *   - At most ONE automatic retry, under the SAME server-generated idempotency key.
 *   - Only for an explicitly classified transient infrastructure failure
 *     (`transient-failures.ts` — currently none, so no retry happens).
 *   - NEVER for a domain/business error or a spec 035 pipeline error (every `ApiRouteError`), and
 *     never for `MCP_IDEMPOTENCY_KEY_REQUIRED`. A declined payment's `details.retryable: true`
 *     (spec 021) is a signal for the USER and never triggers an automatic retry.
 *   - Never for a tool that needed confirmation: spec 035's confirmation is single-use and was
 *     consumed by the first attempt, so a retry could not pass step 6 and would misreport an effect
 *     that may have committed. Such a failure stays `unknown`.
 */
import { ApiRouteError } from '@/lib/api/errors';
import { McpIdempotencyKeyRequiredError } from './errors';
import { isTransientInfrastructureFailure } from './transient-failures';

export const MAX_AUTOMATIC_RETRIES = 1;

export function shouldRetry(err: unknown, retriesSoFar: number, requiresConfirmation: boolean): boolean {
  if (retriesSoFar >= MAX_AUTOMATIC_RETRIES) return false;
  if (requiresConfirmation) return false;
  if (err instanceof ApiRouteError || err instanceof McpIdempotencyKeyRequiredError) return false;
  return isTransientInfrastructureFailure(err);
}
