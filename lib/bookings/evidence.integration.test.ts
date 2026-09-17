import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportFileAssetData } from '@/lib/files/privacy';
import { completeBooking } from './complete';
import { getCompletionEvidenceGate, resetCompletionEvidenceGate } from './completion-evidence';
import { listBookingEvidence } from './evidence';
import { listBookingMilestones } from './milestones';
import {
  driveToInProgress,
  freshKey,
  isDatabaseReachable,
  resetMessagingIntegration,
  resetServiceExecutionIntegration,
  seedConfirmedBooking,
  setCompletionEvidenceRequired,
  softDeleteAsset,
  uploadEvidence,
  useMessagingIntegration,
  useServiceExecutionIntegration,
  useTemporaryStorageDir,
} from './service-execution-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 028 §6 — the completion-evidence gate (AC-4, AC-5, AC-12).
 *
 * Everything here runs against a booking seeded through the real 015→021 chain and driven to
 * `in_progress` through spec 020's own routes, with evidence uploaded through spec 027's real
 * upload/finalize path. No `file_assets` row is faked.
 */
describe.skipIf(!dbReachable)('completion evidence gate (spec 028, integration)', { timeout: 60_000 }, () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());

  beforeEach(() => {
    useMessagingIntegration();
    useServiceExecutionIntegration();
  });
  afterEach(() => {
    resetMessagingIntegration();
    resetServiceExecutionIntegration();
  });

  /** AC-5 — the shipped default for every service: nothing requires evidence. */
  it('a service not requiring evidence completes without any', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);

    const booking = await completeBooking(scenario.provider.userId, bookingId, 'provider');
    expect(booking.status).toBe('completed');
  });

  /**
   * AC-4 — the requirement comes from the CATALOG. The only thing that changes between this test
   * and the one above is `services.completion_evidence_required`; the request is identical.
   */
  it('requirement comes from services, and blocks completion until evidence exists', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await setCompletionEvidenceRequired(scenario.serviceId, true);
    await driveToInProgress(scenario, bookingId);

    await expect(completeBooking(scenario.provider.userId, bookingId, 'provider')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
      status: 422,
    });

    await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    const booking = await completeBooking(scenario.provider.userId, bookingId, 'provider');
    expect(booking.status).toBe('completed');
  });

  /**
   * AC-4's load-bearing half — a provider cannot talk their way past the requirement. The gate takes
   * no argument but the booking id, and `completeBooking`'s only evidence input is a list of ids
   * that must ALREADY be this booking's evidence.
   */
  it('no client-supplied value can skip, clear or weaken the requirement', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await setCompletionEvidenceRequired(scenario.serviceId, true);
    await driveToInProgress(scenario, bookingId);

    // An empty declaration, and an absent one, are judged identically — by the database count.
    await expect(completeBooking(scenario.provider.userId, bookingId, 'provider', [])).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
    });
    await expect(completeBooking(scenario.provider.userId, bookingId, 'provider', undefined)).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
    });

    // The gate's contract itself: booking id in, requirement out. Nothing else is an input.
    expect(getCompletionEvidenceGate().length).toBeLessThanOrEqual(2);
  });

  /** AC-4 — the gate is consulted IDENTICALLY for both parties (spec 020 safeguard S5). */
  it('blocks the customer exactly as it blocks the provider', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await setCompletionEvidenceRequired(scenario.serviceId, true);
    await driveToInProgress(scenario, bookingId);

    await expect(completeBooking(scenario.customer.userId, bookingId, 'customer')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
      status: 422,
    });
    await expect(completeBooking(scenario.provider.userId, bookingId, 'provider')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
      status: 422,
    });

    // And once evidence exists, the CUSTOMER may complete it too — the gate is not a provider gate.
    await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
    expect((await completeBooking(scenario.customer.userId, bookingId, 'customer')).status).toBe('completed');
  });

  /** §8 #5 — an asset deleted before completion stops counting, immediately. */
  it('a soft-deleted or unready asset does not satisfy the requirement', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await setCompletionEvidenceRequired(scenario.serviceId, true);
    await driveToInProgress(scenario, bookingId);

    // Reserved but never finalized: `pending`, not `ready`.
    await uploadEvidence(scenario.provider.userId, 'provider', bookingId, { finalize: false });
    await expect(completeBooking(scenario.provider.userId, bookingId, 'provider')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
    });

    const readyId = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
    await softDeleteAsset(readyId);
    await expect(completeBooking(scenario.provider.userId, bookingId, 'provider')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
    });

    await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
    expect((await completeBooking(scenario.provider.userId, bookingId, 'provider')).status).toBe('completed');
  });

  /** Rolling spec 028 back returns spec 020's port to its inert default — §9 "Rollback". */
  it('unregistering the gate restores spec 020s pre-028 behaviour', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await setCompletionEvidenceRequired(scenario.serviceId, true);
    await driveToInProgress(scenario, bookingId);

    resetCompletionEvidenceGate();
    expect((await completeBooking(scenario.provider.userId, bookingId, 'provider')).status).toBe('completed');
  });

  /** AC-12 — the export projection carries no storage key, checksum, scan internals or owner id. */
  it('exported evidence metadata carries no storage key, checksum or counterparty id', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);
    await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    const exported = await exportFileAssetData(scenario.provider.userId);
    expect(exported.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(exported);
    for (const forbidden of ['storageKey', 'storage_key', 'checksum', 'scanOutcome', 'scan_outcome', 'uploadedByUserId']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    expect(serialized).not.toContain(scenario.customer.userId);
  });

  /** AC-3 — a booking completes perfectly well having never seen a milestone. */
  it('completion never depends on a milestone having been posted', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);

    expect(await listBookingMilestones(scenario.provider.userId, bookingId)).toEqual([]);
    expect((await completeBooking(scenario.provider.userId, bookingId, 'provider')).status).toBe('completed');
    expect(await listBookingEvidence(scenario.provider.userId, bookingId)).toEqual([]);
    void freshKey;
  });
});
