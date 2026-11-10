/**
 * Spec 036 AC-2, AC-4, AC-6 — `authorize_payment` through the REAL catalogue executor, spec 035's
 * pipeline and spec 021's REAL `authorizePayment` + sandbox adapter. Master spec §115: a repeated
 * payment tool call cannot double-charge; §132.7: a failed payment is never reported as success.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRejectedToolCall, type AiProposedAction } from '@/lib/ai-assistant/executor';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { createBooking } from '@/lib/bookings';
import { resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { seedBookingScenario, type BookingScenario } from '@/lib/bookings/bookings-test-support';
import { getPool } from '@/lib/db';
import { paymentProviderUnavailableError } from '@/lib/payments/errors';
import {
  amountWithSandboxSuffix,
  paymentAttempts,
  resetPaymentIntegration,
  storedPayment,
  usePaymentIntegration,
} from '@/lib/payments/payments-test-support';
import { PAYMENT_PROVIDER_ENV_VAR } from '@/lib/payments/provider';
import { SANDBOX_DECLINE_AMOUNT_SUFFIX } from '@/lib/payments/provider/sandbox';
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
import { authorizePaymentTool } from './authorize-payment';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('spec 036 authorize_payment (integration)', { timeout: 90_000 }, () => {
  let executor: Awaited<ReturnType<typeof useToolCatalog>>;

  beforeEach(async () => {
    resetRateLimitState();
    usePaymentIntegration();
    executor = await useToolCatalog();
  });

  afterEach(() => {
    resetToolCatalog();
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  async function pendingBooking(priceAmountMinorUnits?: number): Promise<{ scenario: BookingScenario; bookingId: string }> {
    const scenario = await seedBookingScenario(priceAmountMinorUnits ? { priceAmountMinorUnits } : undefined);
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), { offerId: scenario.offerId });
    return { scenario, bookingId: booking.id };
  }

  async function confirmAndExecute(scenario: BookingScenario, bookingId: string) {
    const conversationId = await seedConversation(scenario.customer.userId);
    const ctx = contextFor(scenario.customer, conversationId);
    const proposed = (await executor.interpretTurn(ctx, toolCallOutput('authorize_payment', { bookingId }))) as AiProposedAction;
    expect(isRejectedToolCall(proposed)).toBe(false);
    expect(proposed.parameters.map((p) => p.label)).toContain('Price');
    const resolved = (await executor.resolveConfirmation(ctx, proposed.confirmationId!))!;
    const aiActionId = await seedPendingAction(conversationId, 'authorize_payment', 'high');
    return { outcome: await executor.execute(ctx, aiActionId, resolved), aiActionId };
  }

  it('a confirmed payment reports exactly the persisted, adapter-confirmed state (spec 021 AC-8)', async () => {
    const { scenario, bookingId } = await pendingBooking();
    const { outcome, aiActionId } = await confirmAndExecute(scenario, bookingId);
    expect(outcome.status).toBe('succeeded');
    const payment = (outcome as { data: { id: string; status: string } }).data;
    expect((await storedPayment(bookingId))!.status).toBe(payment.status);

    const [call] = await toolCallRows(aiActionId);
    expect(call!.output_summary).toEqual({ type: 'payment', id: payment.id, status: payment.status });
    expect(JSON.stringify(call)).not.toMatch(/provider_reference|providerReference|sandbox_/);
  });

  it('the same server key replays — one payment, no second adapter attempt (master spec §115)', async () => {
    const { scenario, bookingId } = await pendingBooking();
    const key = randomUUID();
    const context = { userId: scenario.customer.userId, sessionId: scenario.customer.sessionId, activeMode: 'customer' as const, isAdmin: false, idempotencyKey: key };
    const first = await authorizePaymentTool.definition.execute({ bookingId }, context);
    const attemptsAfterFirst = (await paymentAttempts(bookingId)).length;
    const second = await authorizePaymentTool.definition.execute({ bookingId }, context);
    expect(second.id).toBe(first.id);
    expect((await paymentAttempts(bookingId)).length).toBe(attemptsAfterFirst);
  });

  it('a declined payment is a structured failure with spec 021’s own code and details — never success, never auto-retried', async () => {
    const { scenario, bookingId } = await pendingBooking(amountWithSandboxSuffix(SANDBOX_DECLINE_AMOUNT_SUFFIX));
    const { outcome, aiActionId } = await confirmAndExecute(scenario, bookingId);
    expect(outcome).toMatchObject({
      status: 'failed',
      error: { code: 'PAYMENT_FAILED', details: { retryable: true }, retryable: false },
    });
    const calls = await toolCallRows(aiActionId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.error_code).toBe('PAYMENT_FAILED');
  });

  it('an unconfigured payment provider is spec 021’s own domain answer, not an "unknown" outcome', async () => {
    const { scenario, bookingId } = await pendingBooking();
    const saved = process.env[PAYMENT_PROVIDER_ENV_VAR];
    delete process.env[PAYMENT_PROVIDER_ENV_VAR];
    try {
      const { outcome } = await confirmAndExecute(scenario, bookingId);
      expect(outcome).toMatchObject({ status: 'failed', error: { code: paymentProviderUnavailableError().code } });
    } finally {
      process.env[PAYMENT_PROVIDER_ENV_VAR] = saved;
    }
  });
});
