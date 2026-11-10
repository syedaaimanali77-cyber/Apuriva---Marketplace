import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { advanceBooking } from '@/lib/bookings/lifecycle';
import { completeBooking } from '@/lib/bookings/complete';
import { createBookingMilestone, listBookingMilestones } from '@/lib/bookings/milestones';
import { listBookingEvidence } from '@/lib/bookings/evidence';
import { bookingHistory, storedBooking } from '@/lib/bookings/bookings-test-support';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import {
  isDatabaseReachable,
  resetMessagingIntegration,
  resetServiceExecutionIntegration,
  seedConfirmedBooking,
  setCompletionEvidenceRequired,
  shiftDwell,
  uploadEvidence,
  useMessagingIntegration,
  useServiceExecutionIntegration,
  useTemporaryStorageDir,
} from '@/lib/bookings/service-execution-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 028 §6 "End-to-end (Vitest)".
 *
 * `e2e/*.spec.ts` is a configured VITEST pattern (vitest.config.ts `include`), not Playwright —
 * there is no browser runner in this repository and this spec does not add one. What makes this
 * end-to-end rather than another integration test is that it walks the whole journey in order:
 * arrival → start → milestone → blocked completion → evidence → completion → customer read.
 */
describe.skipIf(!dbReachable)('service execution, end to end (spec 028)', { timeout: 90_000 }, () => {
  const storage = useTemporaryStorageDir();

  beforeEach(() => {
    useMessagingIntegration();
    useServiceExecutionIntegration();
  });
  afterEach(() => {
    resetMessagingIntegration();
    resetServiceExecutionIntegration();
  });
  afterAll(async () => {
    storage.cleanup();
    await getPool().end();
  });

  it('a provider walks a job from arrival to evidenced completion, and the customer sees it', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const { provider, customer } = scenario;

    // The service requires completion evidence — set in the CATALOG, the only place it can be.
    await setCompletionEvidenceRequired(scenario.serviceId, true);

    // --- Arrival and start: SPEC 020's routes, reused. Spec 028 adds none of its own. ----------
    await advanceBooking(provider.userId, provider.providerProfileId, bookingId, 'arrived');
    expect((await storedBooking(bookingId)).status).toBe('arrived');

    await advanceBooking(provider.userId, provider.providerProfileId, bookingId, 'in_progress');
    expect((await storedBooking(bookingId)).status).toBe('in_progress');

    // --- An optional milestone, which changes nothing about the booking ------------------------
    const input = { milestoneType: 'working' as const, note: 'Deep clean underway' };
    await createBookingMilestone(provider.userId, provider.providerProfileId, bookingId, input, {
      key: randomUUID(),
      fingerprint: idempotencyFingerprint(input),
    });
    expect((await storedBooking(bookingId)).status).toBe('in_progress');
    expect(await listBookingMilestones(customer.userId, bookingId)).toHaveLength(1);

    // The customer can already read the progress update — that is what it is for.
    const seenByCustomer = await listBookingMilestones(customer.userId, bookingId);
    expect(seenByCustomer[0]!.note).toBe('Deep clean underway');

    // --- Completion is BLOCKED while the required evidence is missing --------------------------
    await shiftDwell(bookingId);
    await expect(completeBooking(provider.userId, bookingId, 'provider')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
      status: 422,
    });
    expect((await storedBooking(bookingId)).status).toBe('in_progress');

    // The customer cannot see evidence yet, because there is none and the job is not complete.
    expect(await listBookingEvidence(customer.userId, bookingId)).toEqual([]);

    // --- Evidence, uploaded through spec 027's real path ---------------------------------------
    const assetId = await uploadEvidence(provider.userId, 'provider', bookingId);

    // --- Completion now succeeds ---------------------------------------------------------------
    const completed = await completeBooking(provider.userId, bookingId, 'provider', [assetId]);
    expect(completed.status).toBe('completed');
    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);

    // --- And the customer can now see the evidence (AC-8) --------------------------------------
    const visible = await listBookingEvidence(customer.userId, bookingId);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe(assetId);
    expect(visible[0]!.visibility).toBe('private');
    expect(visible[0]!.status).toBe('ready');

    resetRateLimitState();
  });

  /** The same journey for a service that requires nothing: no evidence, no milestone, no friction. */
  it('a job with no evidence requirement completes with nothing attached', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const { provider, customer } = scenario;

    await advanceBooking(provider.userId, provider.providerProfileId, bookingId, 'arrived');
    await advanceBooking(provider.userId, provider.providerProfileId, bookingId, 'in_progress');
    await shiftDwell(bookingId);

    expect((await completeBooking(provider.userId, bookingId, 'provider')).status).toBe('completed');
    expect(await listBookingMilestones(customer.userId, bookingId)).toEqual([]);
    expect(await listBookingEvidence(customer.userId, bookingId)).toEqual([]);
  });
});
