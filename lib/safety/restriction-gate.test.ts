/**
 * Spec 030 §6 (AC-5 / DECIDED-3) — the restriction port.
 *
 * The behaviour under test is deliberately unusual for this repository: every other port defaults
 * to a harmless no-op, and `checkConversationBlock` even swallows a throwing gate. This one REFUSES
 * loudly, because an admin who asked to restrict an account and heard nothing would reasonably
 * conclude the account was restricted. Fabricating an enforcement outcome is worse than refusing
 * one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSafetyRestrictionGate,
  registerSafetyRestrictionGate,
  requestRestriction,
  resetSafetyRestrictionGate,
} from './restriction-gate';

const REQUEST = {
  safetyReportId: '11111111-1111-1111-1111-111111111111',
  targetUserId: '22222222-2222-2222-2222-222222222222',
  requestedByAdminUserId: '33333333-3333-3333-3333-333333333333',
  reason: 'A reason long enough to be recorded.',
  correlationId: 'corr-1',
};

afterEach(() => {
  resetSafetyRestrictionGate();
});

describe('spec 030 SafetyRestrictionGate (AC-5)', () => {
  it('REFUSES by default rather than silently succeeding', async () => {
    await expect(requestRestriction(REQUEST)).rejects.toMatchObject({ code: 'RESTRICTION_UNAVAILABLE' });
  });

  it('refuses with a 422, not a 500 — an uninstalled capability is not a server fault', async () => {
    await expect(requestRestriction(REQUEST)).rejects.toMatchObject({ status: 422 });
  });

  it('lets spec 038 register the real implementation', async () => {
    registerSafetyRestrictionGate(async () => ({ moderationActionId: 'action-1' }));
    await expect(requestRestriction(REQUEST)).resolves.toEqual({ moderationActionId: 'action-1' });
  });

  it('passes the whole request through unchanged, so spec 038 has what it needs to audit', async () => {
    const seen: unknown[] = [];
    registerSafetyRestrictionGate(async (req) => {
      seen.push(req);
      return { moderationActionId: 'a' };
    });
    await requestRestriction(REQUEST);
    expect(seen).toEqual([REQUEST]);
  });

  it('does NOT swallow an error from a registered gate — the failure must reach the admin', async () => {
    registerSafetyRestrictionGate(async () => {
      throw new Error('spec 038 said no');
    });
    await expect(requestRestriction(REQUEST)).rejects.toThrow('spec 038 said no');
  });

  it('resets to the refusing default, so one suite cannot leak a gate into another', async () => {
    registerSafetyRestrictionGate(async () => ({ moderationActionId: 'a' }));
    resetSafetyRestrictionGate();
    await expect(getSafetyRestrictionGate()(REQUEST)).rejects.toMatchObject({ code: 'RESTRICTION_UNAVAILABLE' });
  });
});
