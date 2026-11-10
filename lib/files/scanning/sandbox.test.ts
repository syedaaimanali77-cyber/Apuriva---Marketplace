import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTemporaryStorageDir } from '../files-test-support';
import { resolveFileStorageAdapter } from '../storage';
import {
  EICAR_TEST_STRING,
  FILE_SCANNER_ENV_VAR,
  FileScannerUnavailable,
  SANDBOX_SCANNER_NAME,
  TEST_UNKNOWN_MARKER,
  TEST_UNSAFE_MARKER,
  createSandboxFileScanner,
  resolveFileScanner,
} from './index';

const originalScanner = process.env[FILE_SCANNER_ENV_VAR];
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/** Spec 027 AC-4, AC-11 — the sandbox is deterministic and documented, and refuses production. */
describe('sandbox file scanner (spec 027 AC-4, AC-11)', () => {
  let storage: ReturnType<typeof useTemporaryStorageDir>;

  beforeEach(() => {
    storage = useTemporaryStorageDir();
    setNodeEnv('test');
  });

  afterEach(() => {
    storage.cleanup();
    if (originalScanner === undefined) delete process.env[FILE_SCANNER_ENV_VAR];
    else process.env[FILE_SCANNER_ENV_VAR] = originalScanner;
    setNodeEnv(originalNodeEnv);
  });

  async function scanContent(content: Buffer | string) {
    const storageKey = `scan/${Math.random().toString(36).slice(2)}`;
    const bytes = typeof content === 'string' ? Buffer.from(content, 'latin1') : content;
    await resolveFileStorageAdapter().write(storageKey, bytes, 'application/octet-stream');
    return createSandboxFileScanner().scan({
      fileAssetId: '11111111-1111-1111-1111-111111111111',
      storageKey,
      mimeType: 'application/octet-stream',
      sizeBytes: bytes.length,
    });
  }

  it('maps EICAR and the documented test markers to rejected/unknown/clean, deterministically', async () => {
    expect(await scanContent(EICAR_TEST_STRING)).toEqual({ outcome: 'rejected', reasonCode: 'eicar' });
    expect(await scanContent(`prefix ${TEST_UNSAFE_MARKER} suffix`)).toEqual({
      outcome: 'rejected',
      reasonCode: 'test_marker',
    });
    expect(await scanContent(`prefix ${TEST_UNKNOWN_MARKER} suffix`)).toEqual({ outcome: 'unknown' });
    expect(await scanContent('an ordinary file with no marker at all')).toEqual({ outcome: 'clean' });

    // Deterministic: the same bytes always give the same verdict.
    for (let i = 0; i < 3; i += 1) {
      expect(await scanContent(EICAR_TEST_STRING)).toEqual({ outcome: 'rejected', reasonCode: 'eicar' });
    }
  });

  it('an object it cannot read is `unknown`, never `clean`', async () => {
    // A missing object, and an empty one. Neither was inspected, so neither gets a clean bill of
    // health — `clean` must mean "read and found nothing", not "read nothing".
    const missing = await createSandboxFileScanner().scan({
      fileAssetId: '11111111-1111-1111-1111-111111111111',
      storageKey: `never-written/${Math.random().toString(36).slice(2)}`,
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
    });
    expect(missing).toEqual({ outcome: 'unknown' });
    expect(await scanContent(Buffer.alloc(0))).toEqual({ outcome: 'unknown' });
  });

  it('a rejection carries only a CODE, never scanner internals', async () => {
    const result = await scanContent(EICAR_TEST_STRING);
    expect(result.reasonCode).toBe('eicar');
    expect(JSON.stringify(result)).not.toContain('X5O!P');
  });

  it('declares itself a sandbox, so the guard can recognise it', () => {
    const scanner = createSandboxFileScanner();
    expect(scanner.name).toBe(SANDBOX_SCANNER_NAME);
    expect(scanner.isSandbox).toBe(true);
  });

  it('the scanner factory refuses a sandbox under NODE_ENV=production', () => {
    process.env[FILE_SCANNER_ENV_VAR] = SANDBOX_SCANNER_NAME;
    setNodeEnv('test');
    expect(resolveFileScanner().name).toBe(SANDBOX_SCANNER_NAME);

    setNodeEnv('production');
    expect(() => resolveFileScanner()).toThrow(FileScannerUnavailable);
    expect(() => resolveFileScanner()).toThrow(/sandbox and must never run in production/);
  });

  it('refuses an unknown scanner name rather than silently downgrading to the sandbox', () => {
    process.env[FILE_SCANNER_ENV_VAR] = 'some-antivirus-we-have-no-licence-for';
    expect(() => resolveFileScanner()).toThrow(/is not a known file scanner/);
  });
});
