/**
 * Spec 032 §6 "Unit" — request parsing (AC-4, AC-9).
 *
 * The most important case here is the `priority` rejection: AC-4 says a ticket's priority is never
 * taken from the request body, and the parser is where that becomes true at the edge rather than a
 * thing the insert happens to ignore.
 */
import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import {
  normalizeSupportText,
  parseAssistantRequest,
  parseCreateTicketRequest,
  parseHandOffRequest,
  parsePriorityChangeRequest,
  parseResolveRequest,
  parseSupportMessageRequest,
} from './validation';

const VALID_UUID = '66666666-6666-4666-8666-666666666666';

function expectValidation(fn: () => unknown, field: string): void {
  try {
    fn();
    throw new Error('expected a validation error');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRouteError);
    const apiError = err as ApiRouteError;
    expect(apiError.code).toBe('VALIDATION_ERROR');
    expect(apiError.errors?.some((e) => e.field === field)).toBe(true);
  }
}

describe('parseCreateTicketRequest', () => {
  const valid = { subject: 'Cannot log in', description: 'I keep getting an error when I try.', category: 'account' };

  it('accepts a well-formed ticket with no context', () => {
    const parsed = parseCreateTicketRequest(valid);
    expect(parsed.category).toBe('account');
    expect(parsed.contextType).toBeNull();
    expect(parsed.contextId).toBeNull();
  });

  it('REJECTS a client-supplied priority, with a message explaining why (AC-4)', () => {
    try {
      parseCreateTicketRequest({ ...valid, priority: 'critical' });
      throw new Error('expected a validation error');
    } catch (err) {
      const apiError = err as ApiRouteError;
      expect(apiError.code).toBe('VALIDATION_ERROR');
      const message = apiError.errors?.find((e) => e.field === 'priority')?.message ?? '';
      expect(message).toMatch(/not accepted/);
      expect(message).toMatch(/category/);
    }
  });

  it('rejects any unrecognised field, so nothing is silently ignored', () => {
    expectValidation(() => parseCreateTicketRequest({ ...valid, slaDeadlineAt: 'soon' }), 'slaDeadlineAt');
    expectValidation(() => parseCreateTicketRequest({ ...valid, assignedAdminUserId: VALID_UUID }), 'assignedAdminUserId');
  });

  it('rejects an unknown category rather than defaulting one', () => {
    expectValidation(() => parseCreateTicketRequest({ ...valid, category: 'billing' }), 'category');
  });

  it('requires contextType and contextId together, mirroring the pairing constraint', () => {
    expectValidation(() => parseCreateTicketRequest({ ...valid, contextType: 'booking' }), 'contextId');
    expectValidation(() => parseCreateTicketRequest({ ...valid, contextId: VALID_UUID }), 'contextId');
  });

  it('rejects a malformed context id before any lookup happens', () => {
    expectValidation(
      () => parseCreateTicketRequest({ ...valid, contextType: 'booking', contextId: 'not-a-uuid' }),
      'contextId',
    );
  });

  it('enforces the subject and description bounds', () => {
    expectValidation(() => parseCreateTicketRequest({ ...valid, subject: 'hi' }), 'subject');
    expectValidation(() => parseCreateTicketRequest({ ...valid, description: 'short' }), 'description');
  });

  it('normalizes before bounding, so whitespace alone cannot pass or fail a ticket', () => {
    const parsed = parseCreateTicketRequest({ ...valid, subject: '  Cannot log in  ' });
    expect(parsed.subject).toBe('Cannot log in');
  });
});

describe('parseResolveRequest (AC-9 shape)', () => {
  const base = { reason: 'Explained the charge and confirmed it settled.', expectedStatus: 'assigned' };

  it('requires a handoff target when handing off', () => {
    expectValidation(() => parseResolveRequest({ ...base, resolutionKind: 'handed_off' }), 'handoffTarget');
  });

  it('refuses a handoff target on a resolution that is not a handoff', () => {
    expectValidation(
      () => parseResolveRequest({ ...base, resolutionKind: 'answered', handoffTarget: 'safety' }),
      'handoffTarget',
    );
  });

  it('accepts a matched pair', () => {
    const parsed = parseResolveRequest({ ...base, resolutionKind: 'handed_off', handoffTarget: 'refunds' });
    expect(parsed.handoffTarget).toBe('refunds');
  });

  it('requires a reason of real length — master 70 wants a reason, not a keystroke', () => {
    expectValidation(() => parseResolveRequest({ ...base, reason: 'ok', resolutionKind: 'answered' }), 'reason');
  });
});

describe('parseHandOffRequest', () => {
  const base = { reason: 'Escalating to the safety team for review.', expectedStatus: 'assigned' };

  it('requires a target user for a safety handoff', () => {
    expectValidation(() => parseHandOffRequest({ ...base, target: 'safety' }), 'targetUserId');
  });

  it('requires an existing dispute id for a dispute handoff', () => {
    expectValidation(() => parseHandOffRequest({ ...base, target: 'dispute' }), 'disputeId');
  });

  it('needs neither for a refunds handoff — Finance acts through spec 022 own route', () => {
    const parsed = parseHandOffRequest({ ...base, target: 'refunds' });
    expect(parsed.targetUserId).toBeNull();
    expect(parsed.disputeId).toBeNull();
  });
});

describe('parsePriorityChangeRequest — the one parser that accepts a priority', () => {
  it('accepts a valid priority with a reason', () => {
    const parsed = parsePriorityChangeRequest({ priority: 'critical', reason: 'Customer reports a safety concern.', expectedStatus: 'assigned' });
    expect(parsed.priority).toBe('critical');
  });

  it('still rejects an unknown priority', () => {
    expectValidation(
      () => parsePriorityChangeRequest({ priority: 'urgent', reason: 'A good reason here.', expectedStatus: 'assigned' }),
      'priority',
    );
  });
});

describe('parseSupportMessageRequest and parseAssistantRequest', () => {
  it('defaults requestsInformation to false', () => {
    expect(parseSupportMessageRequest({ body: 'Any update?' }).requestsInformation).toBe(false);
  });

  it('rejects an over-long body at spec 025 bound', () => {
    expectValidation(() => parseSupportMessageRequest({ body: 'x'.repeat(2001) }), 'body');
  });

  it('accepts a question and rejects an empty one', () => {
    expect(parseAssistantRequest({ question: 'How do I cancel?' }).question).toBe('How do I cancel?');
    expectValidation(() => parseAssistantRequest({ question: '   ' }), 'question');
  });
});

describe('normalizeSupportText', () => {
  it('strips control and bidi characters that must never reach a stored record', () => {
    expect(normalizeSupportText('hel\u0000lo‮world')).toBe('helloworld');
  });

  it('collapses runaway blank lines and trims', () => {
    expect(normalizeSupportText('a\n\n\n\n\nb  ')).toBe('a\n\nb');
  });

  it('returns null for text that is only whitespace', () => {
    expect(normalizeSupportText('   \n\t ')).toBeNull();
  });
});
