/**
 * Spec 031 §6 "Privacy" — DECIDED-10, asserted over the SERIALIZED DTO rather than the type.
 *
 * WHY SERIALIZED. A TypeScript interface proves nothing at runtime: a mapper that spread an extra
 * column would still typecheck if the extra key were structurally compatible, and would still ship
 * the id. So these tests build a row containing every secret, map it, and assert the secrets are
 * absent from `JSON.stringify` of the result. That is the form the leak would actually take.
 */
import { describe, expect, it } from 'vitest';
import {
  actorRole,
  toAdminDisputeDto,
  toAppealDto,
  toDisputeDto,
  toEvidenceDto,
  toMessageDto,
  toResolutionDto,
  type AdminDisputeRow,
  type AppealRow,
  type ParticipantDisputeRow,
  type ResolutionRow,
} from './rows';

const ME = '11111111-1111-4111-8111-111111111111';
const COUNTERPARTY = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const SAFETY_REPORT = '44444444-4444-4444-8444-444444444444';
const ADMIN_ACTION = '55555555-5555-4555-8555-555555555555';

const CREATED = new Date('2026-09-01T10:00:00.000Z');
const RESOLVED = new Date('2026-09-02T10:00:00.000Z');

const participantRow: ParticipantDisputeRow = {
  id: 'dispute-1',
  booking_id: 'booking-1',
  opened_by_user_id: COUNTERPARTY,
  status: 'resolved',
  reason: 'The provider never arrived.',
  created_at: CREATED,
  closed_at: null,
};

const adminRow: AdminDisputeRow = {
  ...participantRow,
  claimed_by_admin_user_id: ADMIN,
  ai_summary: 'Advisory: customer reports a no-show.',
  legal_hold: true,
  escalated_safety_report_id: SAFETY_REPORT,
  version: 3,
};

const resolutionRow: ResolutionRow = {
  dispute_id: 'dispute-1',
  decision: 'partial_refund_customer',
  reasoning: 'Partial refund reflects the work actually completed.',
  resolved_by_admin_user_id: ADMIN,
  resolved_at: RESOLVED,
  proposed_refund_amount_minor_units: 12_500,
  proposed_refund_currency_code: 'PKR',
  refund_admin_action_id: ADMIN_ACTION,
};

const appealRow: AppealRow = {
  dispute_id: 'dispute-1',
  appellant_user_id: COUNTERPARTY,
  reason: 'The job was not completed at all.',
  outcome: 'upheld',
  reasoning: 'The original decision stands.',
  reviewed_by_admin_user_id: ADMIN,
  decided_at: RESOLVED,
  created_at: RESOLVED,
};

const aggregate = {
  resolution: toResolutionDto(resolutionRow, 'initiated'),
  appeal: appealRow,
  evidenceCount: 2,
  messageCount: 4,
  appealWindowEndsAt: new Date('2026-09-09T10:00:00.000Z'),
};

describe('participant DTOs never carry another identity (spec 031 DECIDED-10)', () => {
  const dto = toDisputeDto(participantRow, ME, aggregate, {
    canAppeal: true,
    canPostMessage: false,
    canSubmitEvidence: false,
  });
  const json = JSON.stringify(dto);

  it('carries no counterparty user id', () => {
    expect(json).not.toContain(COUNTERPARTY);
  });

  it('carries no admin user id', () => {
    expect(json).not.toContain(ADMIN);
  });

  it('carries no AI summary', () => {
    expect(json).not.toContain('Advisory');
    expect(dto).not.toHaveProperty('aiSummary');
  });

  it('carries no refund approval chain', () => {
    expect(json).not.toContain(ADMIN_ACTION);
    expect(dto).not.toHaveProperty('refundAdminActionId');
  });

  it('carries no safety cross-reference and no legal-hold flag', () => {
    expect(json).not.toContain(SAFETY_REPORT);
    expect(dto).not.toHaveProperty('escalatedSafetyReportId');
    expect(dto).not.toHaveProperty('legalHold');
  });

  it('projects the opener to a relative role', () => {
    expect(dto.openedBy).toBe('counterparty');
    expect(toDisputeDto({ ...participantRow, opened_by_user_id: ME }, ME, aggregate, {
      canAppeal: false,
      canPostMessage: false,
      canSubmitEvidence: false,
    }).openedBy).toBe('me');
  });

  it('DOES carry the resolution reasoning and the proposed amount — master §2.3, and it is their money', () => {
    expect(dto.resolution?.reasoning).toBe('Partial refund reflects the work actually completed.');
    expect(dto.resolution?.proposedRefundAmountMinorUnits).toBe(12_500);
    expect(dto.resolution?.proposedRefundCurrencyCode).toBe('PKR');
  });

  it('never exposes who resolved it, even while exposing what they decided', () => {
    expect(JSON.stringify(dto.resolution)).not.toContain(ADMIN);
    expect(dto.resolution).not.toHaveProperty('resolvedByAdminUserId');
  });
});

describe('admin DTO carries exactly what a participant DTO must not', () => {
  const dto = toAdminDisputeDto(adminRow, aggregate, { customerUserId: ME, providerUserId: COUNTERPARTY }, resolutionRow);

  it('carries the real identities, the summary, the chain, the escalation and the hold', () => {
    expect(dto.openedByUserId).toBe(COUNTERPARTY);
    expect(dto.customerUserId).toBe(ME);
    expect(dto.providerUserId).toBe(COUNTERPARTY);
    expect(dto.claimedByAdminUserId).toBe(ADMIN);
    expect(dto.resolvedByAdminUserId).toBe(ADMIN);
    expect(dto.aiSummary).toBe('Advisory: customer reports a no-show.');
    expect(dto.refundAdminActionId).toBe(ADMIN_ACTION);
    expect(dto.escalatedSafetyReportId).toBe(SAFETY_REPORT);
    expect(dto.legalHold).toBe(true);
  });

  it('never claims an appeal was filed by the admin reading it', () => {
    // `toAppealDto` is reused with a viewer id matching nobody, so `filedBy` cannot read 'me'.
    expect(dto.appeal?.filedBy).toBe('counterparty');
  });
});

describe('actor projection (spec 031 DECIDED-10)', () => {
  it('labels the viewer as me and anyone else as counterparty', () => {
    expect(actorRole(ME, ME)).toBe('me');
    expect(actorRole(ME, COUNTERPARTY)).toBe('counterparty');
  });

  it('labels an admin as admin rather than comparing their id to a party', () => {
    // Comparing an admin's id to a participant's would answer "counterparty", implying the admin
    // is a party to the booking.
    expect(actorRole(ME, ADMIN, true)).toBe('admin');
    expect(actorRole(ME, ME, true)).toBe('admin');
  });

  it('labels evidence and messages by relative role, never by id', () => {
    const evidence = toEvidenceDto(
      { id: 'e1', file_asset_id: 'f1', submitted_by_user_id: COUNTERPARTY, created_at: CREATED },
      ME,
      new Set(),
    );
    expect(evidence.submittedBy).toBe('counterparty');
    expect(JSON.stringify(evidence)).not.toContain(COUNTERPARTY);

    const message = toMessageDto(
      { id: 'm1', sender_user_id: ADMIN, body: 'Official note.', is_admin: true, created_at: CREATED },
      ME,
    );
    expect(message.authorRole).toBe('admin');
    expect(JSON.stringify(message)).not.toContain(ADMIN);
  });

  it('labels an appeal by relative role and never leaks the reviewing admin', () => {
    const appeal = toAppealDto(appealRow, ME);
    expect(appeal.filedBy).toBe('counterparty');
    expect(JSON.stringify(appeal)).not.toContain(ADMIN);
    expect(JSON.stringify(appeal)).not.toContain(COUNTERPARTY);
    // The outcome and its reasoning DO reach the parties.
    expect(appeal.outcome).toBe('upheld');
    expect(appeal.reasoning).toBe('The original decision stands.');
  });
});
