import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { mcpAuthorizationFailedError, mcpConfirmationStaleError } from '@/lib/mcp/errors';
import { McpIdempotencyKeyRequiredError, MCP_IDEMPOTENCY_KEY_REQUIRED, toOutcome } from './errors';

/** Spec 036 §3 "Errors" / AC-4 — the domain's own error reaches the AI unchanged; nothing reads as success. */
describe('spec 036 error outcomes', () => {
  it('preserves a domain error’s code, message and details unchanged, as a confirmed failure', () => {
    const alternatives = [{ scheduledAt: '2026-10-01T07:00:00.000Z' }];
    const err = new ApiRouteError('SLOT_NO_LONGER_AVAILABLE', 'Ali is no longer available at 5 PM.', { status: 409, details: { alternatives } });
    expect(toOutcome(err)).toEqual({
      status: 'failed',
      error: { code: 'SLOT_NO_LONGER_AVAILABLE', message: 'Ali is no longer available at 5 PM.', details: { alternatives }, retryable: false },
    });
  });

  it('passes spec 018’s OFFER_EXPIRED through with its own code — no MCP wrapper code', () => {
    const outcome = toOutcome(new ApiRouteError('OFFER_EXPIRED', 'This offer expired — the provider can send a new one.', { status: 422 }));
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'OFFER_EXPIRED' } });
    expect(JSON.stringify(outcome)).not.toContain('MCP_DOMAIN_ERROR');
  });

  it('keeps field-level validation errors in details', () => {
    const err = new ApiRouteError('MCP_SCHEMA_VALIDATION_FAILED', 'The action could not be prepared.', {
      status: 400,
      errors: [{ field: 'offerId', message: 'must be a UUID' }],
    });
    expect(toOutcome(err)).toMatchObject({ error: { details: { errors: [{ field: 'offerId', message: 'must be a UUID' }] } } });
  });

  it('passes spec 035 pipeline errors through unchanged, still non-disclosing', () => {
    expect(toOutcome(mcpAuthorizationFailedError())).toMatchObject({ status: 'failed', error: { code: 'MCP_AUTHORIZATION_FAILED', message: 'This action is not allowed.' } });
    expect(toOutcome(mcpConfirmationStaleError())).toMatchObject({ status: 'failed', error: { code: 'MCP_CONFIRMATION_STALE' } });
  });

  it('keeps MCP_IDEMPOTENCY_KEY_REQUIRED distinct from VALIDATION_ERROR', () => {
    const outcome = toOutcome(new McpIdempotencyKeyRequiredError('create_booking'));
    expect(outcome).toMatchObject({ status: 'failed', error: { code: MCP_IDEMPOTENCY_KEY_REQUIRED, retryable: false } });
  });

  it('an unexpected failure is "unknown" with spec 004’s INTERNAL_ERROR — never success, never a guessed failure', () => {
    expect(toOutcome(new Error('connection reset'))).toEqual({
      status: 'unknown',
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', retryable: false },
    });
  });

  it('nothing it produces can be read as a success', () => {
    for (const err of [new Error('x'), mcpAuthorizationFailedError(), new McpIdempotencyKeyRequiredError('t')]) {
      expect(toOutcome(err).status).not.toBe('succeeded');
    }
  });
});
