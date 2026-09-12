import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing (spec 005 §3 `password_hash`) via Node's built-in `scrypt` — no new
 * dependency (bcrypt/argon2) added. Format: `scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>` so the cost
 * parameters travel with the hash and can be upgraded later without breaking existing hashes.
 */
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltHex!, 'hex');
  const expected = Buffer.from(hashHex!, 'hex');
  const actual = scryptSync(password, salt, expected.length, { N, r, p });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
