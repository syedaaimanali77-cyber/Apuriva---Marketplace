import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DELIVERY_TRANSFORM } from '../optimization';
import { useTemporaryStorageDir } from '../files-test-support';
import {
  FILE_STORAGE_PROVIDER_ENV_VAR,
  FileStorageUnavailable,
  LOCAL_STORAGE_ADAPTER_NAME,
  createLocalFileStorageAdapter,
  resolveFileStorageAdapter,
} from './index';

const originalProvider = process.env[FILE_STORAGE_PROVIDER_ENV_VAR];
const originalCdn = process.env.FILE_PUBLIC_CDN_BASE_URL;
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/** Spec 027 AC-3, AC-11 — the local adapter, and the production guard in front of it. */
describe('local file storage adapter (spec 027 AC-3, AC-11)', () => {
  let storage: ReturnType<typeof useTemporaryStorageDir>;

  beforeEach(() => {
    storage = useTemporaryStorageDir();
    setNodeEnv('test');
  });

  afterEach(() => {
    storage.cleanup();
    if (originalProvider === undefined) delete process.env[FILE_STORAGE_PROVIDER_ENV_VAR];
    else process.env[FILE_STORAGE_PROVIDER_ENV_VAR] = originalProvider;
    if (originalCdn === undefined) delete process.env.FILE_PUBLIC_CDN_BASE_URL;
    else process.env.FILE_PUBLIC_CDN_BASE_URL = originalCdn;
    setNodeEnv(originalNodeEnv);
  });

  it('round-trips bytes, and head/readPrefix report ACTUAL values', async () => {
    const adapter = createLocalFileStorageAdapter();
    const bytes = Buffer.from('hello spec 027, these are real bytes');
    // A unique key per run: the adapter's directory is shared by every suite (see
    // `useTemporaryStorageDir`), exactly as it is in a real deployment.
    const key = `local-test/${randomUUID()}`;

    expect(await adapter.head(key)).toEqual({ exists: false, sizeBytes: 0, contentType: null });
    expect(await adapter.readAll(key)).toBeNull();
    expect(await adapter.readPrefix(key, 8)).toEqual(Buffer.alloc(0));

    await adapter.write(key, bytes, 'application/octet-stream');

    const head = await adapter.head(key);
    expect(head.exists).toBe(true);
    // The ACTUAL size, read from the object — not anything the caller declared.
    expect(head.sizeBytes).toBe(bytes.length);
    expect(await adapter.readAll(key)).toEqual(bytes);
    expect(await adapter.readPrefix(key, 5)).toEqual(bytes.subarray(0, 5));

    await adapter.delete(key);
    expect((await adapter.head(key)).exists).toBe(false);
    // Deleting bytes that are already gone is a success, so the purge pass is idempotent.
    await expect(adapter.delete(key)).resolves.toBeUndefined();
  });

  it('publicUrl is null for a private object — because no CDN is configured, not as a placeholder', () => {
    const adapter = createLocalFileStorageAdapter();
    delete process.env.FILE_PUBLIC_CDN_BASE_URL;
    expect(adapter.publicUrl({ storageKey: 'user-1/asset-1' })).toBeNull();

    process.env.FILE_PUBLIC_CDN_BASE_URL = 'https://cdn.example.test/media/';
    const url = adapter.publicUrl({ storageKey: 'user-1/asset-1', transform: DEFAULT_DELIVERY_TRANSFORM })!;
    expect(url).toContain('https://cdn.example.test/media/user-1/asset-1');
    // AC-2: the delivery transform travels on the URL.
    expect(url).toContain('w=1600');
    expect(url).toContain('q=80');
    expect(url).toContain('fm=auto');
  });

  it('a signed URL always expires, and the adapter never returns a permanent one', async () => {
    const adapter = createLocalFileStorageAdapter();
    const before = Date.now();
    const signed = await adapter.createSignedUrl({
      storageKey: 'user-1/asset-1',
      fileAssetId: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      ttlSeconds: 300,
    });
    expect(signed.expiresAt.getTime()).toBeGreaterThan(before);
    expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(before + 300_000 + 1000);
    expect(signed.url).toContain('/content?');
    expect(signed.url).toContain('sig=');
  });

  it('refuses a storage key that resolves outside its root', async () => {
    const adapter = createLocalFileStorageAdapter();
    await expect(adapter.write('../escaped', Buffer.from('x'), 'text/plain')).rejects.toThrow(FileStorageUnavailable);
    await expect(adapter.head('../../etc/passwd')).resolves.toEqual({ exists: false, sizeBytes: 0, contentType: null });
  });

  it('the factory refuses a sandbox adapter under NODE_ENV=production', () => {
    process.env[FILE_STORAGE_PROVIDER_ENV_VAR] = LOCAL_STORAGE_ADAPTER_NAME;
    setNodeEnv('test');
    expect(resolveFileStorageAdapter().name).toBe(LOCAL_STORAGE_ADAPTER_NAME);

    setNodeEnv('production');
    expect(() => resolveFileStorageAdapter()).toThrow(FileStorageUnavailable);
    expect(() => resolveFileStorageAdapter()).toThrow(/sandbox and must never run in production/);
  });

  it('refuses an unknown provider name rather than falling back to local storage', () => {
    process.env[FILE_STORAGE_PROVIDER_ENV_VAR] = 'some-object-store-we-have-no-account-with';
    expect(() => resolveFileStorageAdapter()).toThrow(/is not a known file storage provider/);
  });

  it('re-reads configuration on every call, so nothing can warm a cache past the guard', () => {
    process.env[FILE_STORAGE_PROVIDER_ENV_VAR] = LOCAL_STORAGE_ADAPTER_NAME;
    setNodeEnv('test');
    expect(() => resolveFileStorageAdapter()).not.toThrow();
    setNodeEnv('production');
    expect(() => resolveFileStorageAdapter()).toThrow(FileStorageUnavailable);
  });
});
