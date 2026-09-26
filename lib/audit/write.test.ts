import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spec 039 §3.2/§3.5/§3.11 — the writer's mapping and failure contract, without a database: the
 * insert is captured so every column the writer produces can be asserted exactly.
 */
const captured: { values: Record<string, unknown> | null } = { values: null };
const insertBehaviour: { fail: Error | null } = { fail: null };

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.values = values;
        return {
          returning: async () => {
            if (insertBehaviour.fail) throw insertBehaviour.fail;
            return [{ id: 'row-1' }];
          },
        };
      },
    }),
  }),
}));

const { resolveApprovalRef, resolveCorrelationId, toJsonbValue, writeAuditEntry } = await import('@/lib/audit/write');
const { runWithRequestContext } = await import('@/lib/audit/request-context');

const ADMIN_ACTION_ID = '11111111-1111-4111-8111-111111111111';
const BASE = {
  actorType: 'admin' as const,
  actorUserId: '22222222-2222-4222-8222-222222222222',
  actorRoles: ['trust_safety_admin'],
  eventType: 'moderation.action_applied',
  resource: 'moderation',
  action: 'action_applied',
};

beforeEach(() => {
  captured.values = null;
  insertBehaviour.fail = null;
});

afterEach(() => vi.restoreAllMocks());

describe('correlation id precedence (spec 039 D-6)', () => {
  it('an explicit id wins over the request context', () => {
    expect(runWithRequestContext({ correlationId: 'from-request' }, () => resolveCorrelationId('explicit-1'))).toBe('explicit-1');
  });

  it('without an explicit id, the current request context supplies it', () => {
    expect(runWithRequestContext({ correlationId: 'from-request' }, () => resolveCorrelationId(null))).toBe('from-request');
    expect(runWithRequestContext({ correlationId: 'from-request' }, () => resolveCorrelationId(undefined))).toBe('from-request');
  });

  it('outside any request it is null — no placeholder is invented', () => {
    expect(resolveCorrelationId(null)).toBeNull();
    expect(resolveCorrelationId(undefined)).toBeNull();
  });

  it('an explicit id that breaks spec 004 format is not stored; the context is used instead', () => {
    expect(runWithRequestContext({ correlationId: 'ctx' }, () => resolveCorrelationId('has spaces!'))).toBe('ctx');
    expect(resolveCorrelationId('x'.repeat(101))).toBeNull();
  });
});

describe('approval reference (spec 039 D-5)', () => {
  it('an explicit uuid approvalRef is used', () => {
    expect(resolveApprovalRef(ADMIN_ACTION_ID, [])).toBe(ADMIN_ACTION_ID);
  });

  it('falls back to an adminActionId carried in the approval chain (spec 038)', () => {
    expect(resolveApprovalRef(null, { adminActionId: ADMIN_ACTION_ID, initiatedBy: 'x' })).toBe(ADMIN_ACTION_ID);
  });

  it('is null when neither is a uuid, or the chain is not an object', () => {
    expect(resolveApprovalRef('not-a-uuid', { adminActionId: 'pay_1' })).toBeNull();
    expect(resolveApprovalRef(undefined, [])).toBeNull();
    expect(resolveApprovalRef(undefined, null)).toBeNull();
    expect(resolveApprovalRef(undefined, { adminActionId: null })).toBeNull();
  });
});

describe('before/after — recorded only when provided (spec 037 AC-5 X-1)', () => {
  it('undefined is SQL NULL, an explicit null is JSON null, anything else is stored as given', () => {
    expect(toJsonbValue(undefined)).toBeNull();
    expect(toJsonbValue(null)).not.toBeNull();
    expect(toJsonbValue({ a: 1 })).toEqual({ a: 1 });
    expect(toJsonbValue(0)).toBe(0);
  });
});

describe('writeAuditEntry (spec 039 §3.2)', () => {
  it('maps every field onto its column and returns the new row id', async () => {
    const id = await writeAuditEntry({
      ...BASE,
      targetType: 'moderation_action',
      targetId: 'queue',
      reason: 'repeat abuse',
      before: { status: 'active' },
      after: { status: 'banned' },
      approvalChain: { adminActionId: ADMIN_ACTION_ID },
      isEmergencyBypass: true,
      correlationId: 'corr-1',
    });
    expect(id).toBe('row-1');
    expect(captured.values).toMatchObject({
      actorType: 'admin',
      actorUserId: BASE.actorUserId,
      actorRoles: ['trust_safety_admin'],
      eventType: 'moderation.action_applied',
      resource: 'moderation',
      action: 'action_applied',
      targetType: 'moderation_action',
      targetId: 'queue',
      reason: 'repeat abuse',
      beforeValue: { status: 'active' },
      afterValue: { status: 'banned' },
      approvalRef: ADMIN_ACTION_ID,
      approvalChain: { adminActionId: ADMIN_ACTION_ID },
      isEmergencyBypass: true,
      correlationId: 'corr-1',
    });
  });

  it('defaults optional fields to null/empty and takes the correlation id from the request context', async () => {
    await runWithRequestContext({ correlationId: 'req-7' }, () => writeAuditEntry(BASE));
    expect(captured.values).toMatchObject({
      targetType: null,
      targetId: null,
      reason: null,
      beforeValue: null,
      afterValue: null,
      approvalRef: null,
      approvalChain: [],
      isEmergencyBypass: false,
      correlationId: 'req-7',
    });
  });

  it('a failed write is never swallowed: it emits audit.write_failed (critical) and rethrows', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    insertBehaviour.fail = new Error('connection lost');
    await expect(writeAuditEntry({ ...BASE, reason: 'secret reason', after: { secret: true }, correlationId: 'corr-9' })).rejects.toThrow(
      'connection lost',
    );
    expect(error).toHaveBeenCalledTimes(1);
    const line = JSON.parse(error.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      event: 'audit.write_failed',
      severity: 'critical',
      eventType: 'moderation.action_applied',
      resource: 'moderation',
      correlationId: 'corr-9',
      error: 'connection lost',
    });
    // The signal carries no audited content.
    expect(JSON.stringify(line)).not.toContain('secret');
  });

  it('a non-Error failure is reported as text and still rethrown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    insertBehaviour.fail = 'boom' as unknown as Error;
    await expect(writeAuditEntry(BASE)).rejects.toBe('boom');
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toMatchObject({ error: 'boom', correlationId: null });
  });
});
