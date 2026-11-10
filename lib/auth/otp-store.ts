import { randomUUID } from 'node:crypto';
import { generateOtpCode, hashOtpCode, verifyOtpCodeHash } from './otp';
import { getSmsOtpProvider } from './sms-otp-provider';

/**
 * OTP request/verify state — spec 005 AC-1/AC-2. Not a database table: master spec §124 and
 * spec 005 §4 don't list one, and the retention note is explicit ("OTP codes are never persisted
 * ... beyond their short validity window") — an in-memory store with a hard TTL satisfies that
 * directly, the same pattern spec 004's rate limiter already uses for similarly ephemeral state.
 */
const OTP_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes
export const OTP_MAX_ATTEMPTS = 5;

interface OtpEntry {
  phoneNumber: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
}

const requests = new Map<string, OtpEntry>();

export interface CreateOtpRequestResult {
  requestId: string;
  expiresAt: Date;
}

export async function createOtpRequest(phoneNumber: string): Promise<CreateOtpRequestResult> {
  const requestId = randomUUID();
  const code = generateOtpCode();
  const expiresAt = Date.now() + OTP_VALIDITY_MS;

  requests.set(requestId, { phoneNumber, codeHash: hashOtpCode(code), expiresAt, attempts: 0, consumed: false });
  await getSmsOtpProvider().send(phoneNumber, code);

  return { requestId, expiresAt: new Date(expiresAt) };
}

export type ConsumeOtpResult =
  | { ok: true; phoneNumber: string }
  | { ok: false; reason: 'invalid'; justLocked: boolean }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'already_used' }
  | { ok: false; reason: 'rate_limited' };

export function consumeOtpRequest(requestId: string, code: string): ConsumeOtpResult {
  const entry = requests.get(requestId);
  if (!entry) return { ok: false, reason: 'invalid', justLocked: false };
  if (entry.consumed) return { ok: false, reason: 'already_used' };
  if (entry.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'rate_limited' };
  if (Date.now() > entry.expiresAt) return { ok: false, reason: 'expired' };

  if (verifyOtpCodeHash(code, entry.codeHash)) {
    entry.consumed = true;
    return { ok: true, phoneNumber: entry.phoneNumber };
  }

  entry.attempts += 1;
  return { ok: false, reason: 'invalid', justLocked: entry.attempts >= OTP_MAX_ATTEMPTS };
}

/** Test-only: clears all in-memory OTP request state between test cases. */
export function resetOtpStoreState(): void {
  requests.clear();
}
