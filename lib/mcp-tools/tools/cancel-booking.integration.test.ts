/**
 * Spec 036 — `cancel_booking` through the REAL catalogue executor, spec 035's pipeline and spec 023's
 * REAL `cancelBookingAsParticipant`, in the caller's LIVE mode (AC-8). Input is exactly `{ bookingId }`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiProposedAction } from '@/lib/ai-assistant/executor';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { resetCancellationIntegration, seedCapturedBooking, useCancellationIntegration } from '@/lib/cancellation/cancellation-test-support';
import { getPool } from '@/lib/db';
import {
  confirmationRows,
  contextFor,
  isDatabaseReachable,
  resetToolCatalog,
  seedConversation,
  seedPendingAction,
  toolCallOutput,
  toolCallRows,
  useToolCatalog,
} from '../mcp-tools-test-support';
import { cancelBookingTool } from './cancel-booking';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('spec 036 cancel_booking (integration)', { timeout: 90_000 }, () => {
  let executor: Awaited<ReturnType<typeof useToolCatalog>>;

  beforeEach(async () => {
    useCancellationIntegration();
    registerBookingBusyIntervals();
    executor = await useToolCatalog();
  });

  afterEach(() => {
    resetToolCatalog();
    resetCancellationIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('a customer’s confirmed cancellation runs spec 023’s own cancellation and records its summary', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    const conversationId = await seedConversation(scenario.customer.userId);
    const ctx = contextFor(scenario.customer, conversationId);

    const proposed = (await executor.interpretTurn(ctx, toolCallOutput('cancel_booking', { bookingId }))) as AiProposedAction;
    expect(proposed.riskTier).toBe('high');
    // Only the booking id is bound — never a note or a reason.
    const bindings = (await confirmationRows(proposed.confirmationId!)).filter((row) => !['Service', 'Provider', 'Date/time', 'Price'].includes(row.label));
    expect(bindings).toEqual([{ label: 'bookingId', value: bookingId }]);

    const resolved = (await executor.resolveConfirmation(ctx, proposed.confirmationId!))!;
    const aiActionId = await seedPendingAction(conversationId, 'cancel_booking', 'high');
    const outcome = await executor.execute(ctx, aiActionId, resolved);
    expect(outcome.status).toBe('succeeded');
    const cancellation = (outcome as { data: { id: string; bookingId: string } }).data;
    expect(cancellation.bookingId).toBe(bookingId);

    const [call] = await toolCallRows(aiActionId);
    expect(call!.input_params).toEqual({ bookingId });
    expect(call!.output_summary).toEqual({ type: 'cancellation', id: cancellation.id, status: null });
  });

  it('the provider cancels in PROVIDER mode, resolved from the provider’s own live session', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    const conversationId = await seedConversation(scenario.provider.userId);
    const ctx = contextFor(scenario.provider, conversationId);
    const proposed = (await executor.interpretTurn(ctx, toolCallOutput('cancel_booking', { bookingId }))) as AiProposedAction;
    const resolved = (await executor.resolveConfirmation(ctx, proposed.confirmationId!))!;
    const outcome = await executor.execute(ctx, await seedPendingAction(conversationId, 'cancel_booking', 'high'), resolved);
    expect(outcome).toMatchObject({ status: 'succeeded', data: { cancelledByRole: 'provider' } });
  });

  it('the same server key replays the original cancellation', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    const context = { userId: scenario.customer.userId, sessionId: scenario.customer.sessionId, activeMode: 'customer' as const, isAdmin: false, idempotencyKey: randomUUID() };
    const first = await cancelBookingTool.definition.execute({ bookingId }, context);
    const second = await cancelBookingTool.definition.execute({ bookingId }, context);
    expect(second.id).toBe(first.id);
  });

  it('a stranger cannot even get a card for someone else’s booking', async () => {
    const { bookingId } = await seedCapturedBooking();
    const other = await seedCapturedBooking();
    const conversationId = await seedConversation(other.scenario.customer.userId);
    const result = await executor.interpretTurn(contextFor(other.scenario.customer, conversationId), toolCallOutput('cancel_booking', { bookingId }));
    expect(result).toMatchObject({ rejected: true, outcome: { status: 'failed' } });
  });
});
