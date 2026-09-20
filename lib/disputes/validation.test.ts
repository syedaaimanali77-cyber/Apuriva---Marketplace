/**
 * Spec 031 §6 unit — parsing and normalization. PURE: no database, no I/O.
 *
 * The load-bearing case here is the refund pairing (AC-5): a refund decision must carry an amount,
 * and a non-refund decision must not. Both directions are checked, because
 * `dispute_resolutions_refund_pairing_ck` enforces both at the database and a parser that allowed
 * either would turn a validation error into a constraint violation.
 */
import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import {
  normalizeDisputeText,
  parseAppealDecisionRequest,
  parseAppealRequest,
  parseDisputeMessageRequest,
  parseEvidenceLinkRequest,
  parseLegalHoldRequest,
  parseLinkRefundRequest,
  parseOpenDisputeRequest,
  parseResolveRequest,
  parseSafetyEscalationRequest,
} from './validation';

const UUID = '11111111-1111-4111-8111-111111111111';
const REASON = 'The provider did not arrive and did not call.';

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiRouteError) return (err.errors ?? []).map((e) => e.field);
    throw err;
  }
  throw new Error('expected a validation error');
}

describe('normalizeDisputeText (spec 031)', () => {
  it('collapses CRLF, strips zero-width and control characters, and trims', () => {
    expect(normalizeDisputeText('  a\r\nb​c  ')).toBe('a\nb c'.replace(' ', ''));
  });

  it('collapses runs of blank lines to at most one', () => {
    expect(normalizeDisputeText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('returns null for text that is empty once normalized', () => {
    expect(normalizeDisputeText('   ​  ')).toBeNull();
    expect(normalizeDisputeText('')).toBeNull();
  });
});

describe('parseOpenDisputeRequest (spec 031 AC-1)', () => {
  it('accepts a reason within bounds', () => {
    expect(parseOpenDisputeRequest({ reason: REASON })).toEqual({ reason: REASON });
  });

  it('rejects a missing, short or over-long reason', () => {
    expect(fieldsOf(() => parseOpenDisputeRequest({}))).toEqual(['reason']);
    expect(fieldsOf(() => parseOpenDisputeRequest({ reason: 'too short' }))).toEqual(['reason']);
    expect(fieldsOf(() => parseOpenDisputeRequest({ reason: 'x'.repeat(2001) }))).toEqual(['reason']);
  });

  it('normalizes BEFORE measuring, so a whitespace-only difference replays rather than conflicts', () => {
    expect(parseOpenDisputeRequest({ reason: `  ${REASON}  ` }).reason).toBe(REASON);
  });
});

describe('parseDisputeMessageRequest (spec 031 DECIDED-7)', () => {
  it('accepts a one-character body — "yes" is a legitimate contribution to an argument', () => {
    expect(parseDisputeMessageRequest({ body: 'y' })).toEqual({ body: 'y' });
  });

  it('rejects an empty body and one over spec 025 2000-character bound', () => {
    expect(fieldsOf(() => parseDisputeMessageRequest({ body: '   ' }))).toEqual(['body']);
    expect(fieldsOf(() => parseDisputeMessageRequest({ body: 'x'.repeat(2001) }))).toEqual(['body']);
  });
});

describe('parseResolveRequest (spec 031 AC-3, AC-5)', () => {
  const reasoning = 'Both parties agree the job was only partly done.';

  it('accepts a non-refund decision with no amount', () => {
    expect(parseResolveRequest({ decision: 'no_action', reasoning })).toEqual({
      decision: 'no_action',
      reasoning,
      proposedRefundAmountMinorUnits: null,
      proposedRefundCurrencyCode: null,
    });
  });

  it('accepts a refund decision with a positive integer amount and an ISO-4217 code', () => {
    expect(
      parseResolveRequest({
        decision: 'partial_refund_customer',
        reasoning,
        proposedRefundAmountMinorUnits: 12_500,
        proposedRefundCurrencyCode: 'pkr',
      }),
    ).toEqual({
      decision: 'partial_refund_customer',
      reasoning,
      proposedRefundAmountMinorUnits: 12_500,
      proposedRefundCurrencyCode: 'PKR',
    });
  });

  it('AC-5: rejects a refund decision with no amount — a promise nobody could act on', () => {
    expect(fieldsOf(() => parseResolveRequest({ decision: 'refund_customer', reasoning }))).toEqual([
      'proposedRefundAmountMinorUnits',
    ]);
  });

  it('AC-5: rejects an amount attached to a non-refund decision — a number nobody agreed to pay', () => {
    expect(
      fieldsOf(() =>
        parseResolveRequest({ decision: 'no_action', reasoning, proposedRefundAmountMinorUnits: 100, proposedRefundCurrencyCode: 'PKR' }),
      ),
    ).toEqual(['proposedRefundAmountMinorUnits']);
  });

  it('rejects a zero, negative or fractional amount', () => {
    for (const amount of [0, -1, 12.5]) {
      expect(
        fieldsOf(() =>
          parseResolveRequest({
            decision: 'refund_customer',
            reasoning,
            proposedRefundAmountMinorUnits: amount,
            proposedRefundCurrencyCode: 'PKR',
          }),
        ),
      ).toEqual(['proposedRefundAmountMinorUnits']);
    }
  });

  it('rejects a malformed currency code', () => {
    for (const code of ['P', 'PKRX', '123', '']) {
      expect(
        fieldsOf(() =>
          parseResolveRequest({
            decision: 'refund_customer',
            reasoning,
            proposedRefundAmountMinorUnits: 100,
            proposedRefundCurrencyCode: code,
          }),
        ),
      ).toEqual(['proposedRefundCurrencyCode']);
    }
  });

  it('rejects an unknown decision and a missing reasoning', () => {
    expect(fieldsOf(() => parseResolveRequest({ decision: 'ban_them', reasoning }))).toEqual(['decision']);
    expect(fieldsOf(() => parseResolveRequest({ decision: 'no_action' }))).toEqual(['reasoning']);
    expect(fieldsOf(() => parseResolveRequest({ decision: 'no_action', reasoning: 'short' }))).toEqual(['reasoning']);
  });
});

describe('parseAppealRequest / parseAppealDecisionRequest (spec 031 AC-4)', () => {
  it('requires a reason to appeal', () => {
    expect(parseAppealRequest({ reason: REASON })).toEqual({ reason: REASON });
    expect(fieldsOf(() => parseAppealRequest({}))).toEqual(['reason']);
  });

  it('accepts only the three defined outcomes, each with a mandatory reasoning', () => {
    for (const outcome of ['upheld', 'overturned', 'partially_upheld']) {
      expect(parseAppealDecisionRequest({ outcome, reasoning: REASON })).toEqual({ outcome, reasoning: REASON });
    }
    expect(fieldsOf(() => parseAppealDecisionRequest({ outcome: 'dismissed', reasoning: REASON }))).toEqual(['outcome']);
    expect(fieldsOf(() => parseAppealDecisionRequest({ outcome: 'upheld' }))).toEqual(['reasoning']);
  });
});

describe('the remaining parsers (spec 031)', () => {
  it('requires a uuid for an evidence link and for a refund approval chain', () => {
    expect(parseEvidenceLinkRequest({ fileAssetId: UUID })).toEqual({ fileAssetId: UUID });
    expect(fieldsOf(() => parseEvidenceLinkRequest({ fileAssetId: 'nope' }))).toEqual(['fileAssetId']);

    expect(parseLinkRefundRequest({ adminActionId: UUID })).toEqual({ adminActionId: UUID });
    expect(fieldsOf(() => parseLinkRefundRequest({}))).toEqual(['adminActionId']);
  });

  it('requires an explicit boolean and a reason for a legal hold — never an implied default', () => {
    expect(parseLegalHoldRequest({ legalHold: false, reason: REASON })).toEqual({ legalHold: false, reason: REASON });
    expect(fieldsOf(() => parseLegalHoldRequest({ reason: REASON }))).toEqual(['legalHold']);
    expect(fieldsOf(() => parseLegalHoldRequest({ legalHold: true }))).toEqual(['reason']);
  });

  it('requires a target, a category and a reason to escalate to safety', () => {
    expect(parseSafetyEscalationRequest({ targetUserId: UUID, category: 'threat', reason: REASON })).toEqual({
      targetUserId: UUID,
      category: 'threat',
      reason: REASON,
    });
    expect(fieldsOf(() => parseSafetyEscalationRequest({ category: 'threat', reason: REASON }))).toEqual(['targetUserId']);
    expect(fieldsOf(() => parseSafetyEscalationRequest({ targetUserId: UUID, reason: REASON }))).toEqual(['category']);
  });
});
