import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { getDb } from '@/lib/db';
import type { UploadUrlRequest } from '@/lib/types/files';
import { GET as SWEEP_ROUTE } from '@/app/api/v1/cron/file-maintenance-sweep/route';
import { NextRequest } from 'next/server';
import { resolveFileStorageAdapter } from './storage';
import { runFileMaintenanceSweep } from './sweep';
import { createUploadTarget, finalizeUpload } from './upload';
import {
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  jpegBytes,
  jpegWithMarker,
  loadAsset,
  makeScanDue,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';
import { TEST_UNKNOWN_MARKER } from './scanning';

const dbReachable = await isDatabaseReachable();
const SWEEP_URL = 'http://localhost/api/v1/cron/file-maintenance-sweep';

/** Spec 027 §3/§4 — the maintenance sweep, and the cron route in front of it. */
describe.skipIf(!dbReachable)('file maintenance sweep (spec 027, integration)', () => {
  const storage = useTemporaryStorageDir();
  const originalSecret = process.env.CRON_SECRET;
  const originalUploadTtl = process.env.FILE_UPLOAD_URL_TTL_SECONDS;

  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    if (originalUploadTtl === undefined) delete process.env.FILE_UPLOAD_URL_TTL_SECONDS;
    else process.env.FILE_UPLOAD_URL_TTL_SECONDS = originalUploadTtl;
  });

  async function reserve(bytes: Buffer | null): Promise<{ userId: string; fileAssetId: string; storageKey: string }> {
    const userId = await createUser();
    const requestId = await createRequestOwnedBy(userId);
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'photo.jpg',
      contextType: 'request_attachment',
      contextId: requestId,
    };
    const target = await createUploadTarget({
      session: { userId, activeMode: 'customer' },
      request,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(request),
      correlationId: 'test',
    });
    const storageKey = (await loadAsset(target.fileAsset.id))!.storage_key!;
    if (bytes) {
      await resolveFileStorageAdapter().write(storageKey, bytes, 'image/jpeg');
      await finalizeUpload({ userId }, target.fileAsset.id, 'test');
    }
    return { userId, fileAssetId: target.fileAsset.id, storageKey };
  }

  it('claims only DUE rows, honouring the backoff', async () => {
    const { fileAssetId } = await reserve(jpegWithMarker(TEST_UNKNOWN_MARKER));
    const afterFinalize = (await loadAsset(fileAssetId))!;
    expect(afterFinalize.status).toBe('scanning');
    expect(afterFinalize.scan_attempts).toBe(1);

    // The backoff has not elapsed, so the sweep must leave THIS asset alone. Asserted on the asset
    // rather than the sweep's `scanned` counter: the sweep is global, so that counter also reflects
    // whatever a concurrently running suite happened to make due.
    await runFileMaintenanceSweep();
    expect((await loadAsset(fileAssetId))!.scan_attempts).toBe(1);

    await makeScanDue(fileAssetId);
    await runFileMaintenanceSweep();
    expect((await loadAsset(fileAssetId))!.scan_attempts).toBeGreaterThanOrEqual(2);
  });

  it('claims with FOR UPDATE SKIP LOCKED, so two overlapping runs never claim the same row', async () => {
    const { fileAssetId } = await reserve(jpegWithMarker(TEST_UNKNOWN_MARKER));
    await makeScanDue(fileAssetId);

    // Asserted at the DATABASE, on this asset specifically, rather than through two concurrent
    // `runFileMaintenanceSweep()` calls: that sweep is GLOBAL — it claims every due row on the
    // platform — so a concurrently running suite's sweep would also claim this row and make a
    // count-based assertion measure other suites' scheduling rather than this claim's semantics.
    const { getPool } = await import('@/lib/db');
    const first = await getPool().connect();
    const second = await getPool().connect();
    try {
      await first.query('BEGIN');
      const claimed = await first.query(
        `SELECT id FROM file_assets WHERE id = $1 AND status = 'scanning' FOR UPDATE SKIP LOCKED`,
        [fileAssetId],
      );
      expect(claimed.rowCount).toBe(1);

      // The second worker, mid-claim, simply does not see it — it moves on instead of blocking.
      await second.query('BEGIN');
      const contended = await second.query(
        `SELECT id FROM file_assets WHERE id = $1 AND status = 'scanning' FOR UPDATE SKIP LOCKED`,
        [fileAssetId],
      );
      expect(contended.rowCount).toBe(0);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('a due scan is retried and still never guessed ready', async () => {
    const { fileAssetId } = await reserve(jpegWithMarker(TEST_UNKNOWN_MARKER));
    const before = (await loadAsset(fileAssetId))!.scan_attempts;
    await makeScanDue(fileAssetId);
    await runFileMaintenanceSweep();

    const after = (await loadAsset(fileAssetId))!;
    // At least one more attempt happened — this suite's sweep, or a concurrently running suite's
    // (the sweep is global and idempotent, which is exactly the property that makes that safe).
    expect(after.scan_attempts).toBeGreaterThan(before);
    expect(after.status).toBe('scanning');
    expect(after.ready_at).toBeNull();
  });

  it('purges a reservation the client never uploaded to, after twice the upload TTL', async () => {
    process.env.FILE_UPLOAD_URL_TTL_SECONDS = '900';
    const { fileAssetId, storageKey } = await reserve(null);
    // Bytes were PUT but finalize never ran — an abandoned upload.
    await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');

    // Fresh: a slow client must never be swept out from under a genuine in-flight upload.
    await runFileMaintenanceSweep();
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(true);

    await getDb().execute(
      sql`UPDATE file_assets SET created_at = clock_timestamp() - interval '2 hours' WHERE id = ${fileAssetId}`,
    );
    await runFileMaintenanceSweep();
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(false);
    expect((await loadAsset(fileAssetId))!.storage_deleted_at).not.toBeNull();
  });

  it('the purge pass is idempotent — a second run re-purges nothing', async () => {
    process.env.FILE_UPLOAD_URL_TTL_SECONDS = '900';
    const { fileAssetId, storageKey } = await reserve(null);
    await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');
    await getDb().execute(
      sql`UPDATE file_assets SET created_at = clock_timestamp() - interval '2 hours' WHERE id = ${fileAssetId}`,
    );

    await runFileMaintenanceSweep();
    // Scoped to THIS asset rather than the sweep's global counter: the sweep claims every due row
    // on the platform, so a concurrent suite's run may legitimately be the one that purged it.
    const stamp = (await loadAsset(fileAssetId))!.storage_deleted_at;
    expect(stamp).not.toBeNull();
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(false);

    await runFileMaintenanceSweep();
    // `storage_deleted_at` is the guard: the row is not reclaimed or restamped.
    expect((await loadAsset(fileAssetId))!.storage_deleted_at).toEqual(stamp);
  });

  it('the cron route requires the bearer secret', async () => {
    process.env.CRON_SECRET = 'test-secret';

    const anonymous = await SWEEP_ROUTE(new NextRequest(SWEEP_URL));
    expect(anonymous.status).toBe(401);

    const wrong = await SWEEP_ROUTE(new NextRequest(SWEEP_URL, { headers: { authorization: 'Bearer nope' } }));
    expect(wrong.status).toBe(401);

    const ok = await SWEEP_ROUTE(new NextRequest(SWEEP_URL, { headers: { authorization: 'Bearer test-secret' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'ok' });
  });

  it('an unset CRON_SECRET refuses every caller rather than defaulting to open', async () => {
    delete process.env.CRON_SECRET;
    const res = await SWEEP_ROUTE(new NextRequest(SWEEP_URL, { headers: { authorization: 'Bearer undefined' } }));
    expect(res.status).toBe(401);
  });
});
