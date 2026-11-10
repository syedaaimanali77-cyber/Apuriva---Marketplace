import { describe, expect, it } from 'vitest';
import {
  parseAppealRequest,
  parseCreateModerationActionRequest,
  parseDecideAppealRequest,
  parseReasonOnly,
  parseTriageRequest,
} from './validation';

const USER = '00000000-0000-4000-8000-000000000001';
const PROFILE = '00000000-0000-4000-8000-000000000002';
const BOOKING = '00000000-0000-4000-8000-000000000003';

function fields(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    return ((err as { errors?: { field: string }[] }).errors ?? []).map((e) => e.field);
  }
  return [];
}

describe('moderation request validation (spec 038 §3.14/§3.15)', () => {
  it('AC-1: a missing, blank or over-long reason is 400 VALIDATION_ERROR on field reason', () => {
    for (const reason of [undefined, '', '   ', 'x'.repeat(501)]) {
      let code: string | undefined;
      try {
        parseCreateModerationActionRequest({ actionType: 'warning', scope: 'account', targetUserId: USER, reason });
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      expect(code).toBe('VALIDATION_ERROR');
      expect(fields(() => parseCreateModerationActionRequest({ actionType: 'warning', scope: 'account', targetUserId: USER, reason }))).toContain('reason');
    }
  });

  it('accepts a valid account warning and trims text', () => {
    const parsed = parseCreateModerationActionRequest({
      actionType: 'warning',
      scope: 'account',
      targetUserId: USER,
      reason: '  Repeated rude messages.  ',
      userMessage: '  Please keep it civil.  ',
    });
    expect(parsed.reason).toBe('Repeated rude messages.');
    expect(parsed.userMessage).toBe('Please keep it civil.');
  });

  it('rejects unknown enums and non-uuid ids', () => {
    expect(fields(() => parseCreateModerationActionRequest({ actionType: 'nuke', scope: 'planet', targetUserId: 'x', reason: 'r' }))).toEqual(
      expect.arrayContaining(['actionType', 'scope', 'targetUserId']),
    );
    expect(
      fields(() => parseCreateModerationActionRequest({ actionType: 'warning', scope: 'account', targetUserId: USER, reason: 'r', originFraudSignalId: 'nope' })),
    ).toContain('originFraudSignalId');
  });

  it('booking_intervention needs scope booking, a booking id and a refund treatment — and only it may carry them', () => {
    expect(fields(() => parseCreateModerationActionRequest({ actionType: 'booking_intervention', scope: 'account', targetUserId: USER, reason: 'r' }))).toEqual(
      expect.arrayContaining(['scope', 'bookingId', 'refundTreatment']),
    );
    expect(
      parseCreateModerationActionRequest({
        actionType: 'booking_intervention',
        scope: 'booking',
        targetUserId: USER,
        bookingId: BOOKING,
        refundTreatment: 'full',
        reason: 'r',
      }).refundTreatment,
    ).toBe('full');
    expect(
      fields(() => parseCreateModerationActionRequest({ actionType: 'warning', scope: 'booking', targetUserId: USER, bookingId: BOOKING, refundTreatment: 'bogus', reason: 'r' })),
    ).toEqual(expect.arrayContaining(['scope', 'bookingId', 'refundTreatment']));
  });

  it('payout_freeze needs scope provider_profile with a profile id; account scope refuses a profile id', () => {
    expect(fields(() => parseCreateModerationActionRequest({ actionType: 'payout_freeze', scope: 'account', targetUserId: USER, reason: 'r' }))).toContain('scope');
    expect(fields(() => parseCreateModerationActionRequest({ actionType: 'suspension', scope: 'provider_profile', targetUserId: USER, reason: 'r' }))).toContain(
      'providerProfileId',
    );
    expect(
      fields(() => parseCreateModerationActionRequest({ actionType: 'warning', scope: 'account', targetUserId: USER, providerProfileId: PROFILE, reason: 'r' })),
    ).toContain('providerProfileId');
  });

  it('rejects a non-string or over-long user message', () => {
    expect(fields(() => parseCreateModerationActionRequest({ actionType: 'warning', scope: 'account', targetUserId: USER, reason: 'r', userMessage: 7 }))).toContain('userMessage');
    expect(
      fields(() => parseCreateModerationActionRequest({ actionType: 'warning', scope: 'account', targetUserId: USER, reason: 'r', userMessage: 'y'.repeat(501) })),
    ).toContain('userMessage');
  });

  it('parses reason-only, triage, appeal and decision bodies', () => {
    expect(parseReasonOnly({ reason: ' undo ' })).toEqual({ reason: 'undo' });
    expect(fields(() => parseReasonOnly(null))).toContain('reason');
    expect(parseTriageRequest({ expectedStatus: 'pending_review', reason: 'noise' }).expectedStatus).toBe('pending_review');
    expect(fields(() => parseTriageRequest({ expectedStatus: 'open', reason: '' }))).toEqual(expect.arrayContaining(['expectedStatus', 'reason']));
    expect(parseAppealRequest({ statement: 'It was not me.' }).statement).toBe('It was not me.');
    expect(fields(() => parseAppealRequest({ statement: 'z'.repeat(2001) }))).toContain('statement');
    expect(parseDecideAppealRequest({ decision: 'upheld', reason: 'Evidence was wrong.' }).decision).toBe('upheld');
    expect(fields(() => parseDecideAppealRequest({ decision: 'maybe' }))).toEqual(expect.arrayContaining(['decision', 'reason']));
  });
});
