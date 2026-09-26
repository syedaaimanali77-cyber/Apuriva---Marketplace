/**
 * Spec 039 test support. Test-only; never imported by production code.
 *
 * X-6: the earlier specs' audit assertions were written against spec 005's `security_events`
 * (`user_id`, `event_type`, and a `metadata` object). Spec 039 moved admin audit events to
 * `audit_logs` (D-1), so those tests change ONLY their query source to `AUDIT_EVENTS` below, which
 * presents `audit_logs` in exactly that legacy shape. Every assertion keeps its meaning, including
 * "recorded only when provided": `correlationId`, `before` and `after` are present in `metadata`
 * only when the row holds a value (a JSON `null` before/after IS a value — see `lib/audit/write.ts`).
 */
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';

const LEGACY_METADATA = `jsonb_build_object(
    'actorRoles', actor_roles,
    'resource', resource,
    'action', action,
    'targetType', target_type,
    'targetId', target_id,
    'reason', reason,
    'approvalChain', approval_chain,
    'isEmergencyBypass', is_emergency_bypass)
  || CASE WHEN correlation_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('correlationId', correlation_id) END
  || CASE WHEN before_value IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('before', before_value) END
  || CASE WHEN after_value IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('after', after_value) END`;

/**
 * `audit_logs` as a derived table with the legacy event columns: `id`, `created_at`, `user_id`
 * (the actor), `event_type`, `metadata`. Use as `FROM ${AUDIT_EVENTS}`.
 */
export const AUDIT_EVENTS = sql.raw(
  `(SELECT id, created_at, actor_user_id AS user_id, event_type, ${LEGACY_METADATA} AS metadata FROM audit_logs) AS audit_events`,
);

export interface AuditEventRow {
  id: string;
  createdAt: Date;
  userId: string | null;
  eventType: string;
  metadata: Record<string, unknown>;
}

export { isDatabaseReachable } from '@/lib/db/test-support';

export type AuditLogRow = typeof auditLogs.$inferSelect;

/** The raw `audit_logs` rows with a given event type, oldest first — spec 039's own assertions. */
export async function auditRowsByEventType(eventType: string): Promise<AuditLogRow[]> {
  return getDb().select().from(auditLogs).where(eq(auditLogs.eventType, eventType)).orderBy(auditLogs.createdAt, auditLogs.id);
}

/** A unique, CHECK-valid event type / tag for one test's rows, so parallel files never collide. */
export function uniqueTag(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Every audit event an actor wrote, newest first — the drizzle-style read the X-6 tests used. */
export async function auditEventsByActor(userId: string): Promise<AuditEventRow[]> {
  return getDb()
    .select({
      id: auditLogs.id,
      createdAt: auditLogs.createdAt,
      userId: auditLogs.actorUserId,
      eventType: auditLogs.eventType,
      metadata: sql<Record<string, unknown>>`${sql.raw(LEGACY_METADATA)}`,
    })
    .from(auditLogs)
    .where(eq(auditLogs.actorUserId, userId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id));
}
