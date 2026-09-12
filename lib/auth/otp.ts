import { randomInt, timingSafeEqual } from 'node:crypto';
import { deriveKey } from './secret';
import { createHmac } from 'node:crypto';

/** Generates a 6-digit numeric OTP code, e.g. "042817". */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** HMAC-peppered hash so a dump of in-memory state doesn't hand over usable codes directly. */
export function hashOtpCode(code: string): string {
  return createHmac('sha256', deriveKey('otp-code')).update(code).digest('hex');
}

export function verifyOtpCodeHash(code: string, hash: string): boolean {
  const actual = Buffer.from(hashOtpCode(code), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
