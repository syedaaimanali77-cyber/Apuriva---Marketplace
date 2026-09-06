import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { conversationParticipants, messages, users } from '@/lib/db/schema';
import { isDatabaseReachable } from '@/lib/db/test-support';
import {
  generateExportPayload,
  getExportDownload,
  getExportStatusDto,
  requestExport,
  runExportSweep,
} from './export';
import { registerFileAssetStorage } from './file-asset-storage';
import { registerTestFileAssetStorage, seedBooking, seedUser } from './test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('lib/privacy/export (spec 008 AC-3, integration)', () => {
  const pool = getPool();

  // Spec 008 depends on spec 027's FileAsset storage capability rather than implementing one —
  // this registers the test double standing in for it (lib/privacy/file-asset-storage.ts).
  beforeAll(() => {
    registerTestFileAssetStorage();
  });

  afterAll(async () => {
    registerFileAssetStorage(null);
    await pool.end();
  });

  it('requestExport is idempotent while pending/processing — returns the same id, not a new one', async () => {
    const userId = await seedUser();
    const first = await requestExport(userId);
    const second = await requestExport(userId);
    expect(second.exportRequestId).toBe(first.exportRequestId);
  });

  it('requestExport starts a new export once the previous one reached a terminal state', async () => {
    const userId = await seedUser();
    const first = await requestExport(userId);
    await getDb().update(users).set({ dataExportStatus: 'ready' }).where(eq(users.id, userId));

    const second = await requestExport(userId);
    expect(second.exportRequestId).not.toBe(first.exportRequestId);
  });

  it("GET status: another user's export id (or a nonexistent one) returns NOT_FOUND", async () => {
    const ownerId = await seedUser();
    const { exportRequestId } = await requestExport(ownerId);

    const strangerId = await seedUser();
    await expect(getExportStatusDto(strangerId, exportRequestId)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(getExportStatusDto(ownerId, 'not-a-real-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('downloadUrl is present only once status is ready', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);

    const pending = await getExportStatusDto(userId, exportRequestId);
    expect(pending.status).toBe('pending');
    expect(pending.downloadUrl).toBeUndefined();

    await runExportSweep();

    const ready = await getExportStatusDto(userId, exportRequestId);
    expect(ready.status).toBe('ready');
    expect(ready.downloadUrl).toBeTruthy();
    expect(ready.expiresAt).toBeTruthy();
  });

  it('depends on the registered FileAsset storage capability rather than a spec-008-owned fallback — without one registered, the export fails honestly instead of faking success', async () => {
    const userId = await seedUser();
    await requestExport(userId);

    registerFileAssetStorage(null);
    try {
      const { processed } = await runExportSweep();
      expect(processed).toBe(0);

      const status = await getDb().select({ dataExportStatus: users.dataExportStatus }).from(users).where(eq(users.id, userId));
      expect(status[0]!.dataExportStatus).toBe('failed');
    } finally {
      registerTestFileAssetStorage();
    }
  });

  it('runExportSweep is idempotent/retry-safe — re-running after ready does not reprocess the account', async () => {
    const userId = await seedUser();
    await requestExport(userId);
    const first = await runExportSweep();
    expect(first.processed).toBeGreaterThanOrEqual(1);

    const second = await runExportSweep();
    expect(second.processed).toBe(0);
  });

  it('generateExportPayload includes only the caller\'s own scoped bookings, never another user\'s', async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    const { bookingId } = await seedBooking(userId, 'in_progress');
    const { bookingId: otherBookingId } = await seedBooking(otherUserId, 'in_progress');

    const payload = await generateExportPayload(userId);
    const bookingIds = payload.bookings.map((b) => b.id);
    expect(bookingIds).toContain(bookingId);
    expect(bookingIds).not.toContain(otherBookingId);
  });

  it("generateExportPayload's messages only include conversations the user participates in (spec 025 boundary)", async () => {
    const memberId = await seedUser();
    const outsiderId = await seedUser();

    const { rows: convoRows } = await pool.query<{ id: string }>('INSERT INTO conversations DEFAULT VALUES RETURNING id');
    const conversationId = convoRows[0]!.id;
    await getDb().insert(conversationParticipants).values({ conversationId, userId: memberId });
    const [message] = await getDb().insert(messages).values({ conversationId, senderUserId: memberId }).returning({ id: messages.id });

    const memberPayload = await generateExportPayload(memberId);
    expect(memberPayload.messages.map((m) => m.id)).toContain(message!.id);

    const outsiderPayload = await generateExportPayload(outsiderId);
    expect(outsiderPayload.messages.map((m) => m.id)).not.toContain(message!.id);
  });

  it('the export payload never carries credentials/tokens/secrets — passwordHash is not one of its keys', async () => {
    const userId = await seedUser();
    const payload = await generateExportPayload(userId);
    expect(Object.keys(payload.profile)).not.toContain('passwordHash');
    expect(JSON.stringify(payload)).not.toMatch(/passwordHash/);
  });

  it('getExportDownload rejects an invalid/missing signature', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);
    await runExportSweep();

    await expect(getExportDownload(exportRequestId, null, null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getExportDownload(exportRequestId, String(Date.now() + 1000), 'deadbeef')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('getExportDownload rejects an expired link even with a well-formed signature shape', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);
    await runExportSweep();

    const expiredMs = Date.now() - 1000;
    await expect(getExportDownload(exportRequestId, String(expiredMs), 'a'.repeat(64))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('getExportDownload succeeds for a valid, unexpired signed link and returns the JSON payload', async () => {
    const userId = await seedUser();
    const { exportRequestId } = await requestExport(userId);
    await runExportSweep();

    const status = await getExportStatusDto(userId, exportRequestId);
    const url = new URL(status.downloadUrl!, 'http://localhost');
    const download = await getExportDownload(exportRequestId, url.searchParams.get('exp'), url.searchParams.get('sig'));
    expect(download.contentType).toBe('application/json');
    const parsed = JSON.parse(download.body);
    expect(parsed.profile.id).toBe(userId);
  });
});
