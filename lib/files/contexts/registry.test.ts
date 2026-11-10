import { afterEach, describe, expect, it } from 'vitest';
import { FILE_CONTEXT_TYPES } from '@/lib/types/files';
import type { FileAssetRow } from '../assets';
import {
  getFileContextPolicy,
  registerFileContextPolicy,
  registeredFileContextTypes,
  resetFileContextPolicies,
  type FileContextPolicy,
} from './registry';
import { registerShippedFileContextPolicies } from './policies';

function stubPolicy(overrides: Partial<FileContextPolicy> = {}): FileContextPolicy {
  return {
    publicEligible: false,
    maxPerContext: 3,
    allowedKinds: ['image'],
    async canUpload() {
      return true;
    },
    async canRead() {
      return true;
    },
    ...overrides,
  };
}

/** Spec 027 AC-8 — a context is usable only while a policy is registered for it. */
describe('file context registry (spec 027 AC-8)', () => {
  afterEach(() => resetFileContextPolicies());

  it('an unregistered context is refused — the registry answers null, it does not invent a default', () => {
    resetFileContextPolicies();
    for (const type of FILE_CONTEXT_TYPES) {
      expect(getFileContextPolicy(type), type).toBeNull();
    }
  });

  it('a registered context is consulted for upload and for read', async () => {
    resetFileContextPolicies();
    const calls: string[] = [];
    registerFileContextPolicy(
      'portfolio',
      stubPolicy({
        async canUpload() {
          calls.push('upload');
          return false;
        },
        async canRead() {
          calls.push('read');
          return true;
        },
      }),
    );

    const policy = getFileContextPolicy('portfolio')!;
    expect(policy).not.toBeNull();
    expect(await policy.canUpload({ userId: 'u1', activeMode: 'provider', contextId: null })).toBe(false);
    expect(await policy.canRead({ userId: 'u1', activeMode: 'provider', asset: {} as FileAssetRow })).toBe(true);
    expect(calls).toEqual(['upload', 'read']);
  });

  it('registration is idempotent and resettable — a repeat replaces rather than accumulates', () => {
    resetFileContextPolicies();
    const first = stubPolicy({ maxPerContext: 1 });
    const second = stubPolicy({ maxPerContext: 9 });

    registerFileContextPolicy('portfolio', first);
    registerFileContextPolicy('portfolio', second);
    expect(registeredFileContextTypes()).toEqual(['portfolio']);
    expect(getFileContextPolicy('portfolio')!.maxPerContext).toBe(9);

    resetFileContextPolicies();
    expect(registeredFileContextTypes()).toEqual([]);
  });

  it('exactly four contexts ship registered; the three reserved ones deliberately do not', () => {
    resetFileContextPolicies();
    registerShippedFileContextPolicies();

    expect(registeredFileContextTypes().sort()).toEqual(
      ['data_export', 'message_attachment', 'portfolio', 'request_attachment'].sort(),
    );
    for (const reserved of ['booking_evidence', 'dispute_evidence', 'verification_document'] as const) {
      expect(getFileContextPolicy(reserved), reserved).toBeNull();
    }

    // `portfolio` is the ONE public-eligible context (AC-2); everything else is private, always.
    expect(getFileContextPolicy('portfolio')!.publicEligible).toBe(true);
    expect(getFileContextPolicy('request_attachment')!.publicEligible).toBe(false);
    expect(getFileContextPolicy('message_attachment')!.publicEligible).toBe(false);
    expect(getFileContextPolicy('data_export')!.publicEligible).toBe(false);
  });

  it("spec 008's export artifacts are refused by the data_export policy itself, not merely by omission", async () => {
    resetFileContextPolicies();
    registerShippedFileContextPolicies();
    const policy = getFileContextPolicy('data_export')!;
    expect(await policy.canUpload({ userId: 'u1', activeMode: 'customer', contextId: null })).toBe(false);
    expect(await policy.canRead({ userId: 'u1', activeMode: 'customer', asset: {} as FileAssetRow })).toBe(false);
    expect(policy.allowedKinds).toEqual([]);
  });
});
