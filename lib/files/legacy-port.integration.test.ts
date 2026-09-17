import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { fileAssets } from '@/lib/db/schema';
import { getFileAssetStorage, registerFileAssetStorage } from '@/lib/privacy/file-asset-storage';
import { buildDownloadUrl } from '@/lib/privacy/download-token';
import { generateExportPayload, getExportDownload } from '@/lib/privacy/export';
import { registerFileIntegration } from './index';
import { exportStorageKey } from './storage/legacy-port';
import { resolveFileStorageAdapter } from './storage';
import { queryRows } from './sql';
import { createUser, isDatabaseReachable, useTemporaryStorageDir } from './files-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 027 AC-10 — spec 008's export pipeline works UNCHANGED once this spec's port is registered.
 *
 * Read what this suite does not do: it imports spec 008's own functions and calls them exactly as the
 * cron and download routes do. Nothing in spec 008 was modified for this to pass —
 * its bare `file_assets` insert still inserts only `uploadedByUserId`, which works precisely
 * because every column migration 0023 added is nullable or defaulted.
 */
describe.skipIf(!dbReachable)("spec 008 storage port compatibility (spec 027 AC-10, integration)", () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());
  beforeEach(() => registerFileIntegration());
  afterEach(() => registerFileAssetStorage(null));

  /**
   * Spec 008's `runExportSweep()` is GLOBAL — it claims every user whose `data_export_status` is
   * `pending`/`processing`, platform-wide. This file therefore deliberately does NOT drive it: a
   * pending user created here would be swept by (and counted in) a concurrently running spec 008
   * suite's own sweep assertions, and a test that breaks another spec's test is not a passing test.
   *
   * What it drives instead is the sweep's BODY, statement for statement, through spec 008's own
   * modules — `generateExportPayload`, its bare `file_assets` insert, and
   * `getFileAssetStorage().store()` — followed by spec 008's own signed download path. That is
   * exactly the three operations AC-10 names, with nothing of spec 008 modified and nothing global
   * perturbed. `lib/privacy/export.integration.test.ts` owns the sweep-loop coverage, and it passes
   * with this spec's port registered.
   */
  it("spec 008's export generation and download succeed unchanged with this spec's adapter registered", async () => {
    const userId = await createUser();

    // 1. Spec 008's own payload generation — which now carries this spec's file metadata too.
    const payload = await generateExportPayload(userId);
    expect(payload).toMatchObject({ files: expect.any(Array) });

    // 2. Spec 008's own BARE insert, unchanged: owner id and nothing else.
    const [asset] = await getDb().insert(fileAssets).values({ uploadedByUserId: userId }).returning({ id: fileAssets.id });

    // 3. The port this spec implements. Before spec 027 this threw, and the export was marked
    //    `failed` — permanently, for every user.
    await getFileAssetStorage().store(asset!.id, JSON.stringify(payload));

    const exportRequestId = randomUUID();
    await getDb().execute(sql`
      UPDATE users SET data_export_request_id = ${exportRequestId}, data_export_status = 'ready',
                       data_export_file_asset_id = ${asset!.id}
       WHERE id = ${userId}
    `);

    // 4. Spec 008's own signed download path, end to end.
    const link = new URL(`http://localhost${buildDownloadUrl(exportRequestId).url}`);
    const download = await getExportDownload(exportRequestId, link.searchParams.get('exp'), link.searchParams.get('sig'));
    expect(download.contentType).toBe('application/json');
    expect(JSON.parse(download.body)).toMatchObject({ files: expect.any(Array) });
  });

  it("spec 008's BARE file_assets insert still works — every added column is nullable or defaulted", async () => {
    const userId = await createUser();
    const [asset] = await queryRows<{
      id: string;
      kind: string;
      visibility: string;
      status: string;
      context_type: string | null;
      storage_key: string | null;
    }>(
      getDb(),
      sql`INSERT INTO file_assets (uploaded_by_user_id) VALUES (${userId})
          RETURNING id, kind, visibility, status, context_type, storage_key`,
    );

    // Such a row reads as a private, pending, context-less document — exactly what it is.
    expect(asset!.kind).toBe('document');
    expect(asset!.visibility).toBe('private');
    expect(asset!.status).toBe('pending');
    expect(asset!.context_type).toBeNull();
    expect(asset!.storage_key).toBeNull();
  });

  it('a context-less export artifact is unreachable through spec 027 routes', async () => {
    const userId = await createUser();
    const [asset] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO file_assets (uploaded_by_user_id) VALUES (${userId}) RETURNING id`,
    );

    const { findLiveAsset } = await import('./assets');
    // Implementing the port opened no second path to an export: spec 008's own signed download
    // route stays the only way to reach one.
    expect(await findLiveAsset(asset!.id)).toBeNull();
  });

  it('store/retrieve round-trip through the SAME adapter every uploaded file uses', async () => {
    const port = getFileAssetStorage();
    // A fresh id per run: the adapter's directory is shared and persists across runs, exactly as a
    // real object store does, so a fixed key would read back a previous run's bytes.
    const fileAssetId = randomUUID();

    expect(await port.retrieve(fileAssetId)).toBeNull();
    await port.store(fileAssetId, '{"hello":"spec 008"}');
    expect(await port.retrieve(fileAssetId)).toBe('{"hello":"spec 008"}');

    // One storage backend in this repository, not two — the bytes are where the adapter put them.
    const direct = await resolveFileStorageAdapter().readAll(exportStorageKey(fileAssetId));
    expect(direct!.toString('utf8')).toBe('{"hello":"spec 008"}');
    // Under their own prefix, so an export key can never collide with an upload key.
    expect(exportStorageKey(fileAssetId)).toBe(`exports/${fileAssetId}`);
  });

  it('registration is idempotent, so a repeated composition-root call is harmless', () => {
    registerFileIntegration();
    registerFileIntegration();
    expect(() => getFileAssetStorage()).not.toThrow();
  });
});
