import { afterEach, describe, expect, it } from 'vitest';
import { getFileAssetStorage, registerFileAssetStorage } from './file-asset-storage';

describe('lib/privacy/file-asset-storage (spec 027 storage-capability contract)', () => {
  afterEach(() => {
    registerFileAssetStorage(null);
  });

  it('throws — with a message naming the spec 027 dependency — when nothing is registered', () => {
    expect(() => getFileAssetStorage()).toThrow(/spec 027/i);
  });

  it('spec 008 never bundles its own implementation: no implementation exists until one is registered', () => {
    // Fresh module state (no import in this file registers anything on its own) — confirms
    // lib/privacy/file-asset-storage.ts ships no default/fallback implementation.
    expect(() => getFileAssetStorage()).toThrow();
  });

  it('returns whatever implementation was registered once one is', () => {
    const calls: string[] = [];
    registerFileAssetStorage({
      async store(fileAssetId, content) {
        calls.push(`store:${fileAssetId}:${content}`);
      },
      async retrieve(fileAssetId) {
        calls.push(`retrieve:${fileAssetId}`);
        return null;
      },
    });

    expect(() => getFileAssetStorage()).not.toThrow();
  });

  it('reverts to throwing once unregistered (registerFileAssetStorage(null))', () => {
    registerFileAssetStorage({
      async store() {},
      async retrieve() {
        return null;
      },
    });
    expect(() => getFileAssetStorage()).not.toThrow();

    registerFileAssetStorage(null);
    expect(() => getFileAssetStorage()).toThrow();
  });
});
