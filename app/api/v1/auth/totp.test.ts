import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOtpAuthUrl, generateTotpCode, generateTotpSecret, verifyTotp } from '@/lib/auth/totp';

describe('TOTP (spec 005 §8 risk #2 — unit)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates a base32-looking secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });

  it('builds a valid otpauth:// provisioning URL', () => {
    const secret = generateTotpSecret();
    const url = buildOtpAuthUrl(secret, 'admin@apuriva.test');
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(url).toContain(`secret=${secret}`);
    expect(url).toContain('issuer=Apuriva');
  });

  it('accepts the current code for a given secret', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('accepts a code from one step in the past (clock-drift tolerance)', () => {
    const secret = generateTotpSecret();
    const thirtySecondsAgo = Date.now() - 30_000;
    const code = generateTotpCode(secret, thirtySecondsAgo);
    expect(verifyTotp(secret, code, 1)).toBe(true);
  });

  it('rejects a code two steps away once the tolerance window is exceeded', () => {
    const secret = generateTotpSecret();
    const twoStepsAgo = Date.now() - 2 * 30_000;
    const code = generateTotpCode(secret, twoStepsAgo);
    expect(verifyTotp(secret, code, 1)).toBe(false);
  });

  it('rejects a non-6-digit code without throwing', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
  });

  it("rejects a code generated from a different secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const codeForB = generateTotpCode(secretB);
    expect(verifyTotp(secretA, codeForB)).toBe(false);
  });
});
