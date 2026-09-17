import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueFileUrl } from '@/lib/files/access';
import { resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import { completeBooking } from './complete';
import { listBookingEvidence } from './evidence';
import {
  driveToInProgress,
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
 * Spec 028 §6 — evidence ownership, context and privacy (AC-6, AC-7, AC-8).
 *
 * This is the suite that proves the sentence spec 028 §3 rests on: "a valid evidence asset for a
 * booking cannot exist without that booking's own provider having created it", and therefore that
 * an unauthorized id can never satisfy completion.
 */
describe.skipIf(!dbReachable)('booking evidence authorization (spec 028, integration)', { timeout: 90_000 }, () => {
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

  /** AC-7 — only the booking's own provider, in provider mode, may attach evidence. */
  it('only the bookings provider may upload, and only in provider mode', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);

    // The customer, who is a participant but not the provider.
    await expect(uploadEvidence(scenario.customer.userId, 'customer', bookingId)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
    // The right person in the wrong mode.
    await expect(uploadEvidence(scenario.provider.userId, 'customer', bookingId)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
    // An unrelated provider.
    const other = await seedConfirmedBooking();
    await expect(uploadEvidence(other.scenario.provider.userId, 'provider', bookingId)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });

    // And the booking's own provider succeeds.
    await expect(uploadEvidence(scenario.provider.userId, 'provider', bookingId)).resolves.toBeTruthy();
  });

  /** AC-7 — evidence may only be attached while the job is actually being executed. */
  it('refuses an upload outside arrived/in_progress', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();

    // `confirmed`: the provider has not arrived yet, so there is nothing to evidence.
    await expect(uploadEvidence(scenario.provider.userId, 'provider', bookingId)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });

    await driveToInProgress(scenario, bookingId);
    await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
    await completeBooking(scenario.provider.userId, bookingId, 'provider');

    // And not after the fact either — evidence bolted on post-completion evidences nothing.
    await expect(uploadEvidence(scenario.provider.userId, 'provider', bookingId)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  /** AC-7 — a `booking_evidence` upload is refused entirely while no policy is registered. */
  it('is 422 FILE_CONTEXT_NOT_AVAILABLE when spec 028 is rolled back', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);

    resetFileContextPolicies();
    registerShippedFileContextPolicies(); // spec 027's shipped four only — spec 028 not registered.

    await expect(uploadEvidence(scenario.provider.userId, 'provider', bookingId)).rejects.toMatchObject({
      code: 'FILE_CONTEXT_NOT_AVAILABLE',
      status: 422,
    });
  });

  /**
   * AC-6 — THE core test. Every way an id can fail to be this booking's evidence, and in none of
   * them does completion succeed or the id get counted.
   */
  it('foreign, unready, deleted and nonexistent ids never satisfy completion', async () => {
    const mine = await seedConfirmedBooking();
    const theirs = await seedConfirmedBooking();
    await setCompletionEvidenceRequired(mine.scenario.serviceId, true);
    await driveToInProgress(mine.scenario, mine.bookingId);
    await driveToInProgress(theirs.scenario, theirs.bookingId);

    // A perfectly valid evidence asset — of somebody ELSE's booking.
    const foreignId = await uploadEvidence(theirs.scenario.provider.userId, 'provider', theirs.bookingId);
    // A reserved-but-never-finalized asset of my own booking.
    const unreadyId = await uploadEvidence(mine.scenario.provider.userId, 'provider', mine.bookingId, {
      finalize: false,
    });
    // A finalized asset of my own booking that was then deleted.
    const deletedId = await uploadEvidence(mine.scenario.provider.userId, 'provider', mine.bookingId);
    await softDeleteAsset(deletedId);

    for (const badId of [foreignId, unreadyId, deletedId, randomUUID(), 'not-a-uuid']) {
      await expect(
        completeBooking(mine.scenario.provider.userId, mine.bookingId, 'provider', [badId]),
        `id ${badId}`,
      ).rejects.toMatchObject({ code: 'EVIDENCE_ASSET_INVALID', status: 422 });
    }

    // None of them counted toward the requirement either: completion is still blocked without a list.
    await expect(completeBooking(mine.scenario.provider.userId, mine.bookingId, 'provider')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
    });

    // One genuine asset, and only then does it succeed.
    const goodId = await uploadEvidence(mine.scenario.provider.userId, 'provider', mine.bookingId);
    // A valid id mixed WITH a foreign one still fails: the list is all-or-nothing.
    await expect(
      completeBooking(mine.scenario.provider.userId, mine.bookingId, 'provider', [goodId, foreignId]),
    ).rejects.toMatchObject({ code: 'EVIDENCE_ASSET_INVALID' });

    const booking = await completeBooking(mine.scenario.provider.userId, mine.bookingId, 'provider', [goodId]);
    expect(booking.status).toBe('completed');
  });

  /** AC-6 — a repeated valid id is not mistaken for two, nor for a missing one. */
  it('collapses duplicate ids rather than miscounting them', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await setCompletionEvidenceRequired(scenario.serviceId, true);
    await driveToInProgress(scenario, bookingId);
    const id = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    const booking = await completeBooking(scenario.provider.userId, bookingId, 'provider', [id, id, id]);
    expect(booking.status).toBe('completed');
  });

  /**
   * AC-8 — the customer's read begins at completion. Before that: an empty list from spec 028's
   * route AND a refusal from spec 027's own read path, so neither is a way in.
   */
  it('the customer sees evidence only after completion; the provider always', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);
    const assetId = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    // Before completion.
    expect(await listBookingEvidence(scenario.customer.userId, bookingId)).toEqual([]);
    await expect(
      issueFileUrl({ userId: scenario.customer.userId, activeMode: 'customer' }, assetId, 'test'),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });

    // The provider, meanwhile, can see their own work all along.
    expect(await listBookingEvidence(scenario.provider.userId, bookingId)).toHaveLength(1);
    await expect(
      issueFileUrl({ userId: scenario.provider.userId, activeMode: 'provider' }, assetId, 'test'),
    ).resolves.toMatchObject({ visibility: 'private' });

    await completeBooking(scenario.provider.userId, bookingId, 'provider');

    // After completion.
    const visible = await listBookingEvidence(scenario.customer.userId, bookingId);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe(assetId);
    await expect(
      issueFileUrl({ userId: scenario.customer.userId, activeMode: 'customer' }, assetId, 'test'),
    ).resolves.toMatchObject({ visibility: 'private' });
  });

  /** AC-8 — a non-participant is refused everywhere, before and after completion. */
  it('a stranger can never read evidence, and never learns a booking exists', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const stranger = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);
    const assetId = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);
    await completeBooking(scenario.provider.userId, bookingId, 'provider');

    await expect(listBookingEvidence(stranger.scenario.customer.userId, bookingId)).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
      status: 404,
    });
    await expect(
      issueFileUrl({ userId: stranger.scenario.provider.userId, activeMode: 'provider' }, assetId, 'test'),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
  });

  /** §4 — evidence is never public, whatever the caller asks for. */
  it('evidence is always private', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await driveToInProgress(scenario, bookingId);
    const assetId = await uploadEvidence(scenario.provider.userId, 'provider', bookingId);

    const listed = await listBookingEvidence(scenario.provider.userId, bookingId);
    expect(listed[0]!.visibility).toBe('private');
    await expect(
      issueFileUrl({ userId: scenario.provider.userId, activeMode: 'provider' }, assetId, 'test'),
    ).resolves.toMatchObject({ visibility: 'private' });
  });
});
