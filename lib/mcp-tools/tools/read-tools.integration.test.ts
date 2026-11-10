/**
 * Spec 036 AC-4, AC-5, AC-8 — the read tools: authoritative data from their domain functions, no key,
 * no mutation, and a domain error passed through unchanged.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiProposedAction } from '@/lib/ai-assistant/executor';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { createBooking } from '@/lib/bookings';
import { resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { seedBookingScenario, type BookingScenario } from '@/lib/bookings/bookings-test-support';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import {
  contextFor,
  isDatabaseReachable,
  resetToolCatalog,
  seedConversation,
  seedPendingAction,
  toolCallOutput,
  toolCallRows,
  useToolCatalog,
} from '../mcp-tools-test-support';

const dbReachable = await isDatabaseReachable();

async function bookingSnapshot(bookingId: string) {
  const [row] = await queryRows<{ status: string; version: number; updated_at: Date }>(
    getDb(),
    sql`SELECT status, version, updated_at FROM bookings WHERE id = ${bookingId}`,
  );
  return row;
}

describe.skipIf(!dbReachable)('spec 036 read tools (integration)', { timeout: 90_000 }, () => {
  let executor: Awaited<ReturnType<typeof useToolCatalog>>;
  let scenario: BookingScenario;
  let bookingId: string;

  beforeEach(async () => {
    resetRateLimitState();
    executor = await useToolCatalog();
    scenario = await seedBookingScenario();
    bookingId = (await createBooking(scenario.customer.userId, randomUUID(), { offerId: scenario.offerId })).booking.id;
  });

  afterEach(() => {
    resetToolCatalog();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function runRead(session: { userId: string; sessionId: string }, name: string, input: Record<string, unknown>) {
    const conversationId = await seedConversation(session.userId);
    const ctx = contextFor(session, conversationId);
    const proposed = (await executor.interpretTurn(ctx, toolCallOutput(name, input))) as AiProposedAction;
    expect(proposed.riskTier).toBe('low');
    expect(proposed.confirmationId).toBeUndefined();
    const aiActionId = await seedPendingAction(conversationId, name, 'low');
    return { outcome: await executor.execute(ctx, aiActionId, proposed), aiActionId };
  }

  it('get_booking returns spec 020’s booking, issues no key and changes nothing (AC-5)', async () => {
    const before = await bookingSnapshot(bookingId);
    const { outcome, aiActionId } = await runRead(scenario.customer, 'get_booking', { bookingId });
    expect(outcome).toMatchObject({ status: 'succeeded', data: { id: bookingId, offerId: scenario.offerId } });
    expect(await bookingSnapshot(bookingId)).toEqual(before);

    const [call] = await toolCallRows(aiActionId);
    expect(call!.idempotency_key).toBeNull();
    expect(call!.output_summary).toEqual({ type: 'booking', id: bookingId, status: before!.status });
  });

  it('the provider reads the same booking in provider mode (AC-8)', async () => {
    const { outcome } = await runRead(scenario.provider, 'get_booking', { bookingId });
    expect(outcome).toMatchObject({ status: 'succeeded', data: { id: bookingId } });
  });

  it('a domain error is passed through with its own code — never a success, never retried', async () => {
    const { outcome, aiActionId } = await runRead(scenario.customer, 'get_booking', { bookingId: randomUUID() });
    expect(outcome.status).toBe('failed');
    const code = (outcome as { error: { code: string } }).error.code;
    expect(code).not.toMatch(/^MCP_/);
    const calls = await toolCallRows(aiActionId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.error_code).toBe(code);
  });

  it('get_request reads the customer’s own request; get_service and search_services read the catalogue', async () => {
    expect((await runRead(scenario.customer, 'get_request', { requestId: scenario.requestId })).outcome).toMatchObject({
      status: 'succeeded',
      data: { id: scenario.requestId },
    });
    expect((await runRead(scenario.customer, 'get_service', { serviceId: scenario.serviceId })).outcome).toMatchObject({
      status: 'succeeded',
      data: { id: scenario.serviceId },
    });
    const search = await runRead(scenario.customer, 'search_services', { serviceId: scenario.serviceId, limit: 5 });
    expect(search.outcome.status).toBe('succeeded');
    const [call] = await toolCallRows(search.aiActionId);
    expect(call!.input_params).toEqual({ serviceId: scenario.serviceId, limit: '[redacted]' });
  });

  it('get_provider_availability and get_notifications answer from their owning modules', async () => {
    expect((await runRead(scenario.customer, 'get_provider_availability', { providerProfileId: scenario.provider.providerProfileId })).outcome).toMatchObject({
      status: 'succeeded',
      data: { state: expect.any(String) },
    });
    expect((await runRead(scenario.customer, 'get_notifications', { unreadOnly: true })).outcome).toMatchObject({
      status: 'succeeded',
      data: { items: expect.any(Array) },
    });
  });

  it('get_provider_earnings is a provider-only read of the caller’s OWN earnings', async () => {
    expect((await runRead(scenario.provider, 'get_provider_earnings', {})).outcome.status).toBe('succeeded');
    const conversationId = await seedConversation(scenario.customer.userId);
    const rejected = await executor.interpretTurn(contextFor(scenario.customer, conversationId), toolCallOutput('get_provider_earnings', {}));
    expect(rejected).toMatchObject({ rejected: true, outcome: { error: { code: 'MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT' } } });
  });
});
