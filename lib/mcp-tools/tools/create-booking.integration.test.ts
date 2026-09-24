/**
 * Spec 036 AC-2, AC-3, AC-7, AC-8, AC-9 — `create_booking` end to end through the REAL catalogue
 * executor, the REAL spec 035 pipeline and spec 020's REAL `createBooking`, on the `*_test` database.
 * Master spec §115's critical example: a repeated booking tool call cannot create two bookings.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRejectedToolCall, type AiProposedAction } from '@/lib/ai-assistant/executor';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { seedBookingScenario, type BookingScenario } from '@/lib/bookings/bookings-test-support';
import { getDb, getPool } from '@/lib/db';
import {
  confirmationRows,
  contextFor,
  countBookingsForOffer,
  isDatabaseReachable,
  resetToolCatalog,
  seedConversation,
  seedPendingAction,
  setActiveMode,
  toolCallOutput,
  toolCallRows,
  useToolCatalog,
} from '../mcp-tools-test-support';
import { createBookingTool } from './create-booking';

const dbReachable = await isDatabaseReachable();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe.skipIf(!dbReachable)('spec 036 create_booking (integration)', { timeout: 90_000 }, () => {
  let executor: Awaited<ReturnType<typeof useToolCatalog>>;
  let scenario: BookingScenario;
  let conversationId: string;

  beforeEach(async () => {
    resetRateLimitState();
    executor = await useToolCatalog();
    scenario = await seedBookingScenario();
    conversationId = await seedConversation(scenario.customer.userId);
  });

  afterEach(() => {
    resetToolCatalog();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  const ctx = () => contextFor(scenario.customer, conversationId);

  async function propose(input: Record<string, unknown> = { offerId: scenario.offerId }): Promise<AiProposedAction> {
    const proposed = await executor.interpretTurn(ctx(), toolCallOutput('create_booking', input));
    if (!proposed || isRejectedToolCall(proposed)) throw new Error(`expected a proposal, got ${JSON.stringify(proposed)}`);
    return proposed;
  }

  it('proposes with a §90 card (no Location, no raw id) bound to server-stored input rows', async () => {
    await getDb().execute(sql`UPDATE provider_profiles SET business_name = 'Ali Raza AC Services' WHERE id = ${scenario.provider.providerProfileId}`);
    const proposed = await propose();
    expect(proposed.riskTier).toBe('high');
    expect(proposed.confirmationId).toBeDefined();
    expect(proposed.parameters.map((p) => p.label)).toEqual(['Service', 'Provider', 'Date/time', 'Price']);
    expect(proposed.parameters.find((p) => p.label === 'Provider')!.value).toBe('Ali Raza AC Services');
    expect(proposed.parameters.some((p) => UUID.test(p.value))).toBe(false);

    const stored = await confirmationRows(proposed.confirmationId!);
    expect(stored).toContainEqual({ label: 'offerId', value: scenario.offerId });
    expect(stored.map((row) => row.label).sort()).toEqual(['Date/time', 'Price', 'Provider', 'Service', 'offerId']);
  });

  it('a value the domain does not hold is left off the card, never invented', async () => {
    await getDb().execute(sql`UPDATE provider_profiles SET business_name = NULL WHERE id = ${scenario.provider.providerProfileId}`);
    const proposed = await propose();
    expect(proposed.parameters.map((p) => p.label)).toEqual(['Service', 'Date/time', 'Price']);
  });

  it('a confirmed booking runs with the stored input and records one tool call with a server key (AC-7, AC-9)', async () => {
    const proposed = await propose();
    const resolved = await executor.resolveConfirmation(ctx(), proposed.confirmationId!);
    expect(resolved!.input).toEqual({ offerId: scenario.offerId });
    expect(resolved!.parameters).toEqual(proposed.parameters);

    const aiActionId = await seedPendingAction(conversationId, 'create_booking', 'high');
    const outcome = await executor.execute(ctx(), aiActionId, resolved!);
    expect(outcome.status).toBe('succeeded');
    const booking = (outcome as { data: { id: string; status: string } }).data;
    expect(await countBookingsForOffer(scenario.offerId)).toBe(1);

    const [call] = await toolCallRows(aiActionId);
    expect(call!.idempotency_key).toMatch(UUID);
    expect(call!.input_params).toEqual({ offerId: scenario.offerId });
    expect(call!.output_summary).toEqual({ type: 'booking', id: booking.id, status: booking.status });
    expect(call!.error_code).toBeNull();
    expect(call!.retried_from_call_id).toBeNull();
  });

  it('executing the same accepted intent again reuses the SAME key and cannot create a second booking (AC-2, AC-3)', async () => {
    const proposed = await propose();
    const resolved = (await executor.resolveConfirmation(ctx(), proposed.confirmationId!))!;
    const aiActionId = await seedPendingAction(conversationId, 'create_booking', 'high');

    const first = await executor.execute(ctx(), aiActionId, resolved);
    const second = await executor.execute(ctx(), aiActionId, resolved);
    expect(first.status).toBe('succeeded');
    // The single-use confirmation was consumed by the first execution: spec 035 refuses the second
    // BEFORE the domain is reached — a real, structured failure, never a second booking.
    expect(second).toMatchObject({ status: 'failed', error: { code: 'MCP_CONFIRMATION_STALE' } });

    const calls = await toolCallRows(aiActionId);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotency_key).toBe(calls[0]!.idempotency_key);
    expect(calls[1]!.error_code).toBe('MCP_CONFIRMATION_STALE');
    expect(await countBookingsForOffer(scenario.offerId)).toBe(1);
  });

  it('the tool wrapper with the same server key replays the original booking — exactly one row (master spec §115)', async () => {
    const key = randomUUID();
    const context = { userId: scenario.customer.userId, sessionId: scenario.customer.sessionId, activeMode: 'customer' as const, isAdmin: false, idempotencyKey: key };
    const input = { offerId: scenario.offerId };
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await createBookingTool.definition.execute(input, context));
    expect(new Set(results.map((booking) => booking.id)).size).toBe(1);
    expect(await countBookingsForOffer(scenario.offerId)).toBe(1);
  });

  it('a card that no longer matches live data is stale, and so is an expired binding — before anything is recorded', async () => {
    const proposed = await propose();
    await getDb().execute(sql`
      UPDATE mcp_confirmation_parameters SET value = 'PKR 1.00'
       WHERE mcp_confirmation_id = ${proposed.confirmationId!} AND label = 'Price'`);
    await expect(executor.resolveConfirmation(ctx(), proposed.confirmationId!)).rejects.toMatchObject({ code: 'MCP_CONFIRMATION_STALE' });

    const again = await propose();
    await getDb().execute(sql`UPDATE mcp_confirmations SET expires_at = now() - interval '1 minute' WHERE id = ${again.confirmationId!}`);
    await expect(executor.resolveConfirmation(ctx(), again.confirmationId!)).rejects.toMatchObject({ code: 'MCP_CONFIRMATION_STALE' });
    expect(await countBookingsForOffer(scenario.offerId)).toBe(0);
  });

  it('a model-supplied idempotency key is rejected back to the model; no confirmation is issued', async () => {
    const result = await executor.interpretTurn(ctx(), toolCallOutput('create_booking', { offerId: scenario.offerId, idempotencyKey: 'mine' }));
    expect(isRejectedToolCall(result)).toBe(true);
    expect(result).toMatchObject({ outcome: { status: 'failed', error: { code: 'MCP_SCHEMA_VALIDATION_FAILED' } } });
  });

  it('the mode comes from the live session: in provider mode create_booking is not available (AC-8)', async () => {
    await setActiveMode(scenario.customer.sessionId, 'provider');
    const result = await executor.interpretTurn(ctx(), toolCallOutput('create_booking', { offerId: scenario.offerId }));
    expect(result).toMatchObject({ rejected: true, outcome: { error: { code: 'MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT' } } });
    expect((await executor.catalogFor(ctx())).map((tool) => tool.name)).not.toContain('create_booking');
  });

  it('another customer’s offer is refused with the domain’s own answer and never produces a card', async () => {
    const stranger = await seedBookingScenario();
    const result = await executor.interpretTurn(ctx(), toolCallOutput('create_booking', { offerId: stranger.offerId }));
    expect(result).toMatchObject({ rejected: true, outcome: { status: 'failed' } });
    expect(await countBookingsForOffer(stranger.offerId)).toBe(0);
  });
});
