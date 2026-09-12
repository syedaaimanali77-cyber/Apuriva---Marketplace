import { randomUUID } from 'node:crypto';
import { stepUpRequiredError } from './errors';
import type { SessionRow } from './session';

/**
 * Step-up re-authentication tokens — spec 005 AC-6. Ephemeral and single-use, like the OTP store
 * (lib/auth/otp-store.ts) — no DB table for the same reason: short-lived by design, not part of
 * spec 005's approved §4 data model.
 */
const STEP_UP_VALIDITY_MS = 5 * 60 * 1000;

interface StepUpEntry {
  sessionId: string;
  action: string;
  expiresAt: number;
  consumed: boolean;
}

const tokens = new Map<string, StepUpEntry>();

export function issueStepUpToken(sessionId: string, action: string): { stepUpToken: string; expiresAt: Date } {
  const stepUpToken = randomUUID();
  const expiresAt = Date.now() + STEP_UP_VALIDITY_MS;
  tokens.set(stepUpToken, { sessionId, action, expiresAt, consumed: false });
  return { stepUpToken, expiresAt: new Date(expiresAt) };
}

/** Single-use: a valid check consumes the token so it can't be replayed for the same action. */
export function verifyAndConsumeStepUpToken(sessionId: string, action: string, stepUpToken: string): boolean {
  const entry = tokens.get(stepUpToken);
  if (!entry || entry.consumed) return false;
  if (entry.sessionId !== sessionId || entry.action !== action) return false;
  if (Date.now() > entry.expiresAt) return false;

  entry.consumed = true;
  return true;
}

/** Test-only: clears all in-memory step-up token state between test cases. */
export function resetStepUpState(): void {
  tokens.clear();
}

/** Header a caller echoes its `POST /api/v1/auth/step-up`-issued token back through — same
 * pattern as `CSRF_HEADER_NAME` (lib/auth/csrf.ts). */
export const STEP_UP_HEADER_NAME = 'x-step-up-token';

/**
 * Route guard for any endpoint requiring fresh step-up re-authentication regardless of normal
 * session freshness (spec 005 AC-6; spec 008 AC-5 sensitive actions: logout-all-devices, MFA
 * enable/disable, deletion). `action` must match what the caller passed to `POST
 * /api/v1/auth/step-up` when it obtained the token. Missing, stale, wrong-action, already-used,
 * or otherwise invalid — all collapse to the same `403 STEP_UP_REQUIRED`, never leaking which.
 */
export function requireStepUp(request: Request, session: Pick<SessionRow, 'id'>, action: string): void {
  const token = request.headers.get(STEP_UP_HEADER_NAME);
  if (!token || !verifyAndConsumeStepUpToken(session.id, action, token)) {
    throw stepUpRequiredError();
  }
}
