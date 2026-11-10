import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { McpIdempotencyKeyRequiredError } from '../errors';
import { authorizePaymentTool } from './authorize-payment';
import { cancelBookingTool } from './cancel-booking';
import { createBookingTool } from './create-booking';
import { getBookingTool } from './get-booking';
import { getProviderEarningsTool } from './get-provider-earnings';
import { searchServicesTool } from './search-services';

const ID = '5d3b1c2e-8f4a-4b6c-9d0e-1f2a3b4c5d6e';

function fieldErrors(fn: () => unknown): Array<{ field: string; message: string }> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRouteError);
    expect((err as ApiRouteError).code).toBe('MCP_SCHEMA_VALIDATION_FAILED');
    return (err as ApiRouteError).errors ?? [];
  }
  throw new Error('expected MCP_SCHEMA_VALIDATION_FAILED');
}

/** Spec 036 §3 — every tool's `validate` is strict (spec 035 §3): extra and identity fields are refused. */
describe('spec 036 tool input validation', () => {
  it('create_booking accepts exactly { offerId, scheduledAt? } and normalizes the instant', () => {
    expect(createBookingTool.definition.validate({ offerId: ID })).toEqual({ offerId: ID });
    expect(createBookingTool.definition.validate({ offerId: ID.toUpperCase(), scheduledAt: '2026-10-01T10:00:00+05:00' })).toEqual({
      offerId: ID,
      scheduledAt: '2026-10-01T05:00:00.000Z',
    });
    expect(fieldErrors(() => createBookingTool.definition.validate({}))[0]!.field).toBe('offerId');
    expect(fieldErrors(() => createBookingTool.definition.validate({ offerId: 'not-a-uuid' }))[0]!.field).toBe('offerId');
    expect(fieldErrors(() => createBookingTool.definition.validate({ offerId: ID, scheduledAt: 'tomorrow' }))[0]!.field).toBe('scheduledAt');
  });

  it('no tool accepts an AI-supplied idempotency key', () => {
    for (const tool of [createBookingTool, cancelBookingTool, authorizePaymentTool]) {
      const input = tool === createBookingTool ? { offerId: ID } : { bookingId: ID };
      expect(fieldErrors(() => tool.definition.validate({ ...input, idempotencyKey: 'model-chosen' }))[0]!.field).toBe('idempotencyKey');
    }
  });

  it('cancel_booking accepts exactly { bookingId } — never the free-text note or the unconstrained reasonCode', () => {
    expect(cancelBookingTool.definition.validate({ bookingId: ID })).toEqual({ bookingId: ID });
    expect(fieldErrors(() => cancelBookingTool.definition.validate({ bookingId: ID, note: 'please' }))[0]!.field).toBe('note');
    expect(fieldErrors(() => cancelBookingTool.definition.validate({ bookingId: ID, reasonCode: 'changed_mind' }))[0]!.field).toBe('reasonCode');
  });

  it('identity fields are refused by name, whatever the tool', () => {
    for (const field of ['userId', 'user_id', 'sessionId', 'isAdmin', 'activeMode']) {
      expect(fieldErrors(() => getBookingTool.definition.validate({ bookingId: ID, [field]: 'x' }))[0]!.field).toBe(field);
    }
  });

  it('read-tool inputs are validated strictly too', () => {
    expect(searchServicesTool.definition.validate({ q: 'ac repair', sort: 'price_asc', limit: 5 })).toEqual({ q: 'ac repair', sort: 'price_asc', limit: 5 });
    expect(fieldErrors(() => searchServicesTool.definition.validate({ sort: 'cheapest' }))[0]!.field).toBe('sort');
    expect(fieldErrors(() => searchServicesTool.definition.validate({ limit: 1000 }))[0]!.field).toBe('limit');
    expect(getProviderEarningsTool.definition.validate({ currency: 'pkr', from: '2026-09-01' })).toEqual({ currency: 'PKR', from: '2026-09-01' });
    expect(fieldErrors(() => getProviderEarningsTool.definition.validate({ from: '09/01/2026' }))[0]!.field).toBe('from');
  });

  it('a state-changing tool refuses with MCP_IDEMPOTENCY_KEY_REQUIRED before its domain function is reached', async () => {
    const context = { userId: ID, sessionId: ID, activeMode: 'customer' as const, isAdmin: false };
    for (const tool of [createBookingTool, cancelBookingTool, authorizePaymentTool]) {
      const input = tool === createBookingTool ? { offerId: ID } : { bookingId: ID };
      // No database is touched: the refusal happens before `run`.
      await expect(tool.definition.execute(input as never, context)).rejects.toBeInstanceOf(McpIdempotencyKeyRequiredError);
    }
  });
});
