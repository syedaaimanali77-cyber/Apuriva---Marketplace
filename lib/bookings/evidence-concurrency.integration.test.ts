import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BookingDto } from '@/lib/types/bookings';
import { completeBooking } from './complete';
import { bookingHistory, storedBooking } from './bookings-test-support';
import {
  driveToInProgress,
  isDatabaseReachable,
  resetMessagingIntegration,
  resetServiceExecutionIntegration,
  seedConfirmedBooking,
  setCompletionEvidenceRequired,
  uploadEvidence,
  useMessagingIntegration,
  useServiceExecutionIntegration,
  useTemporaryStorageDir,
} from './service-execution-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 028 §6 — AC-11: spec 020's AC-9 concurrency rule, preserved under the REAL evidence gate.
 *
 * Spec 020's own `complete-concurrency.integration.test.ts` already proves the rule with a
 * registered stub gate. This suite proves the same thing with spec 028's real gate and real
 * uploaded evidence, because the danger AC-11 guards against is specific to a gate that reads the
 * database: a caller who fails it must still fail even when the other party has already won.
 *
 * REAL CONCURRENCY, NOT MOCKED: each `completeBooking` opens its own transaction on its own pooled
 * connection, so the two genuinely compete for the row lock and the `(status, version)` update.
 */
describe.skipIf(!dbReachable)('completion evidence concurrency (spec 028 AC-11, integration)', { timeout: 90_000 }, () => {
  const storage = useTemporaryStorageDir();

  beforeEach(() => {
    useMessagingIntegration();
    useServiceExecutionIntegration();
  });
  afterEach(() => {
    resetMessagingIntegration();
    resetServiceExecutionIntegration();
  });
  afterAll(() => storage.cleanup());

  async function inProgress(requireEvidence: boolean) {
    const seeded = await seedConfirmedBooking();
    if (requireEvidence) await setCompletionEvidenceRequired(seeded.scenario.serviceId, true);
    await driveToInProgress(seeded.scenario, seeded.bookingId);
    return seeded;
  }

  /**
   * Both parties race on an evidence-requiring booking whose evidence EXISTS. Both pass the gate on
   * their own merits, so exactly one transition is recorded and the loser is an idempotent success.
   */
  it('two valid simultaneous completions record exactly one transition', async () => {
    const { scenario, bookingId } = await inProgress(true);
    await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    const results = await Promise.allSettled([
      completeBooking(scenario.customer.userId, bookingId, 'customer'),
      completeBooking(scenario.provider.userId, bookingId, 'provider'),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      if (result.status === 'fulfilled') expect((result.value as BookingDto).status).toBe('completed');
    }
    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
  });

  /**
   * THE AC-11 CASE. The provider completes legitimately; the customer then arrives declaring a
   * foreign evidence id. The booking is already `completed`, but that must not buy the customer a
   * free pass — their request is rejected on its own merits.
   */
  it('a caller declaring a foreign evidence id is rejected even after the booking is completed', async () => {
    const mine = await inProgress(true);
    const theirs = await inProgress(false);
    await uploadEvidence(mine.scenario.provider.userId, 'provider', mine.bookingId);
    const foreignId = await uploadEvidence(theirs.scenario.provider.userId, 'provider', theirs.bookingId);

    // The provider wins, legitimately.
    expect((await completeBooking(mine.scenario.provider.userId, mine.bookingId, 'provider')).status).toBe('completed');

    // The customer arrives with somebody else's evidence. Already-completed is not a free pass.
    await expect(
      completeBooking(mine.scenario.customer.userId, mine.bookingId, 'customer', [foreignId]),
    ).rejects.toMatchObject({ code: 'EVIDENCE_ASSET_INVALID', status: 422 });

    expect((await bookingHistory(mine.bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
  });

  /** And a genuinely valid retry after the race IS an idempotent success, not an error. */
  it('a valid retry after the booking is completed is an idempotent success', async () => {
    const { scenario, bookingId } = await inProgress(true);
    const assetId = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    await completeBooking(scenario.provider.userId, bookingId, 'provider', [assetId]);
    const retry = await completeBooking(scenario.provider.userId, bookingId, 'provider', [assetId]);

    expect(retry.status).toBe('completed');
    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
    expect((await storedBooking(bookingId)).status).toBe('completed');
    void randomUUID;
  });

  /**
   * The evidence gate is re-evaluated per caller INSIDE the lock, so evidence deleted between the
   * winner's completion and the loser's arrival still blocks the loser.
   */
  it('re-evaluates the gate per caller rather than caching the winners answer', async () => {
    const { scenario, bookingId } = await inProgress(true);
    const assetId = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    await completeBooking(scenario.provider.userId, bookingId, 'provider');

    const { softDeleteAsset } = await import('./service-execution-test-support');
    await softDeleteAsset(assetId);

    await expect(completeBooking(scenario.customer.userId, bookingId, 'customer')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
    });
    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
  });
});
