import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { normalizeProfileName, PROFILE_NAME_MAX_LENGTH, requireExpectedVersion } from './profile';

function rejects(fn: () => unknown, field: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRouteError);
    expect((err as ApiRouteError).status).toBe(400);
    expect((err as ApiRouteError).errors?.[0]?.field).toBe(field);
    return;
  }
  throw new Error('expected a 400 validation error');
}

describe('profile name rules (Account → Profile)', () => {
  it('accepts any script — English, Urdu, Roman Urdu — as written', () => {
    expect(normalizeProfileName('Ayesha Khan', 'displayName')).toBe('Ayesha Khan');
    expect(normalizeProfileName('عائشہ خان', 'displayName')).toBe('عائشہ خان');
    expect(normalizeProfileName('Ayesha ki Dukaan', 'businessName')).toBe('Ayesha ki Dukaan');
    // Urdu legitimately uses the zero-width non-joiner (a format character, not a control character).
    expect(normalizeProfileName('می‌خواهم', 'displayName')).toBe('می‌خواهم');
  });

  it('trims surrounding whitespace; an empty or whitespace-only name, or null, clears it', () => {
    expect(normalizeProfileName('  Ali  ', 'displayName')).toBe('Ali');
    expect(normalizeProfileName('\t Ali \n', 'displayName')).toBe('Ali');
    expect(normalizeProfileName('', 'displayName')).toBeNull();
    expect(normalizeProfileName('   ', 'displayName')).toBeNull();
    expect(normalizeProfileName(null, 'displayName')).toBeNull();
  });

  it('rejects control characters inside the name', () => {
    for (const bad of ['Ali\u0000Khan', 'Ali\nKhan', 'Ali\tKhan', 'Ali\u001bKhan', 'Ali\u007fKhan', 'Ali\u0085Khan']) {
      rejects(() => normalizeProfileName(bad, 'displayName'), 'displayName');
    }
  });

  it('allows exactly 60 characters and rejects 61, counted after trimming', () => {
    expect(PROFILE_NAME_MAX_LENGTH).toBe(60);
    const sixty = 'a'.repeat(60);
    expect(normalizeProfileName(sixty, 'businessName')).toBe(sixty);
    expect(normalizeProfileName(`   ${sixty}   `, 'businessName')).toBe(sixty);
    rejects(() => normalizeProfileName('a'.repeat(61), 'businessName'), 'businessName');
    const urdu60 = 'ب'.repeat(60);
    expect(normalizeProfileName(urdu60, 'displayName')).toBe(urdu60);
    rejects(() => normalizeProfileName('ب'.repeat(61), 'displayName'), 'displayName');
  });

  it('rejects a value that is neither a string nor null', () => {
    for (const bad of [undefined, 42, true, {}, ['Ali']]) rejects(() => normalizeProfileName(bad, 'displayName'), 'displayName');
  });

  it('requires expectedVersion to be a positive integer', () => {
    expect(requireExpectedVersion(1)).toBe(1);
    expect(requireExpectedVersion(7)).toBe(7);
    for (const bad of [undefined, null, 0, -1, 1.5, '1']) rejects(() => requireExpectedVersion(bad), 'expectedVersion');
  });
});
