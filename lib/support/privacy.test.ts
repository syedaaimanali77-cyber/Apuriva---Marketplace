/**
 * Spec 032 §6 "Privacy" (AC-3, DECIDED-11).
 *
 * ASSERTED OVER SERIALIZED JSON, not over the TypeScript type, because a type assertion cannot
 * catch a stray `SELECT *` — spec 031's reasoning, and the reason these run against
 * `JSON.stringify` output rather than against object keys alone.
 *
 * The source-level half matters just as much: no participant code path may read `support_notes` at
 * all, so there is nothing for a projection bug to leak.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  toAdminSupportTicketDto,
  toSupportMessageDto,
  toSupportTicketDto,
  type AdminTicketRow,
  type ParticipantTicketRow,
} from './rows';

const ADMIN_ONLY_FIELDS = [
  'assignedAdminUserId',
  'assigned_admin_user_id',
  'aiSummary',
  'ai_summary',
  'slaDeadlineAt',
  'sla_deadline_at',
  'slaBreached',
  'slaPausedSeconds',
  'awaitingUserSince',
  'legalHold',
  'legal_hold',
  'escalatedSafetyReportId',
  'escalated_safety_report_id',
  'escalatedDisputeId',
  'escalated_dispute_id',
  'idempotencyKey',
  'idempotency_key',
  'idempotencyFingerprint',
  'idempotency_fingerprint',
  'requesterUserId',
  'requester_user_id',
  'description',
];

const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SAFETY_REPORT_ID = '33333333-3333-4333-8333-333333333333';
const DISPUTE_ID = '44444444-4444-4444-8444-444444444444';

const participantRow: ParticipantTicketRow = {
  id: '55555555-5555-4555-8555-555555555555',
  subject: 'Payment did not go through',
  category: 'payment',
  priority: 'high',
  status: 'resolved',
  context_type: 'booking',
  context_id: '66666666-6666-4666-8666-666666666666',
  resolution_kind: 'handed_off',
  resolution_reason: 'Passed to Finance for a refund decision.',
  handoff_target: 'refunds',
  escalated_safety_report_id: SAFETY_REPORT_ID,
  escalated_dispute_id: DISPUTE_ID,
  reopen_count: 0,
  resolved_at: new Date('2026-09-20T10:00:00.000Z'),
  created_at: new Date('2026-09-19T10:00:00.000Z'),
  updated_at: new Date('2026-09-20T10:00:00.000Z'),
};

const adminRow: AdminTicketRow = {
  ...participantRow,
  requester_user_id: REQUESTER_USER_ID,
  requester_mode: 'customer',
  description: 'The card was charged twice and I cannot tell which booking it was for.',
  assigned_admin_user_id: ADMIN_USER_ID,
  sla_deadline_at: new Date('2026-09-19T22:00:00.000Z'),
  sla_paused_seconds: 3600,
  awaiting_user_since: null,
  ai_summary: 'Customer reports a double charge on a booking.',
  legal_hold: true,
  closed_at: null,
  version: 4,
};

describe('the participant projection (AC-3)', () => {
  const dto = toSupportTicketDto(participantRow, { type: 'booking', id: participantRow.context_id!, status: 'protected', available: true }, 3);
  const json = JSON.stringify(dto);

  it('contains no admin-only field, asserted over the serialized payload', () => {
    for (const field of ADMIN_ONLY_FIELDS) {
      expect(json, `participant payload leaked ${field}`).not.toContain(field);
    }
  });

  it('leaks no admin identity and no escalation record id, in any form', () => {
    expect(json).not.toContain(ADMIN_USER_ID);
    expect(json).not.toContain(SAFETY_REPORT_ID);
    expect(json).not.toContain(DISPUTE_ID);
    expect(json).not.toContain(REQUESTER_USER_ID);
  });

  it('tells the user their matter was handed on, as a BOOLEAN and nothing more', () => {
    expect(dto.handedOff).toBe(true);
    expect(json).toContain('"handedOff":true');
  });

  it('does give the user the reason for the decision about them (master 2.3)', () => {
    expect(dto.resolutionReason).toBe('Passed to Finance for a refund decision.');
    expect(dto.resolutionKind).toBe('handed_off');
  });

  it('projects context as a pointer plus a neutral status, never an amount or a party', () => {
    expect(dto.context).toEqual({
      type: 'booking',
      id: participantRow.context_id,
      status: 'protected',
      available: true,
    });
    expect(json).not.toContain('amount');
    expect(json).not.toContain('currency');
  });
});

describe('the admin projection (AC-5)', () => {
  const dto = toAdminSupportTicketDto(adminRow, null, new Date('2026-09-20T12:00:00.000Z'));

  it('carries the operational fields the workspace needs', () => {
    expect(dto.assignedAdminUserId).toBe(ADMIN_USER_ID);
    expect(dto.aiSummary).toBe('Customer reports a double charge on a booking.');
    expect(dto.legalHold).toBe(true);
    expect(dto.escalatedSafetyReportId).toBe(SAFETY_REPORT_ID);
    expect(dto.slaPausedSeconds).toBe(3600);
    expect(dto.requesterMode).toBe('customer');
  });

  it('still carries no idempotency column', () => {
    const json = JSON.stringify(dto);
    expect(json).not.toContain('idempotency');
  });

  it('does not report a resolved ticket as SLA-breached', () => {
    expect(dto.slaBreached).toBe(false);
  });
});

describe('message authorship', () => {
  const base = { id: 'm1', body: 'hello', created_at: new Date('2026-09-20T10:00:00.000Z') };

  it('never reveals which individual replied', () => {
    const adminMessage = toSupportMessageDto({ ...base, sender_user_id: ADMIN_USER_ID, is_admin: true }, REQUESTER_USER_ID);
    expect(adminMessage.author).toBe('support');
    expect(JSON.stringify(adminMessage)).not.toContain(ADMIN_USER_ID);
  });

  it('shows the requester their own words as theirs', () => {
    const own = toSupportMessageDto({ ...base, sender_user_id: REQUESTER_USER_ID, is_admin: false }, REQUESTER_USER_ID);
    expect(own.author).toBe('you');
    expect(JSON.stringify(own)).not.toContain(REQUESTER_USER_ID);
  });
});

describe('internal notes are unreachable from any participant path (source level)', () => {
  const participantModules = ['read.ts', 'create.ts', 'rows.ts', 'context.ts'];

  it('no participant module queries support_notes', () => {
    for (const name of participantModules) {
      const body = readFileSync(join(__dirname, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(body, `${name} must not read support_notes`).not.toMatch(/support_notes/);
    }
  });

  it('the only note mapper lives beside the admin-only reader', () => {
    const rows = readFileSync(join(__dirname, 'rows.ts'), 'utf8');
    // `toSupportNoteDto` exists, but `read.ts` (the participant reader) never imports it.
    expect(rows).toContain('toSupportNoteDto');
    const read = readFileSync(join(__dirname, 'read.ts'), 'utf8');
    expect(read).not.toContain('toSupportNoteDto');
  });
});
