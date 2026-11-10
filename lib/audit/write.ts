/**
 * Spec 039 §3.2 — the ONLY code that inserts into `audit_logs`.
 *
 * This is not a second public audit API (D-9). It is called by exactly two modules, which
 * `lib/audit/boundary.test.ts` asserts:
 *   - spec 009's `recordAdminAuditEvent()` (`lib/admin-rbac/audit.ts`) — the shared admin audit hook
 *     every domain module already calls;
 *   - spec 039's durable MCP sink (`lib/audit/mcp-sink.ts`), behind spec 035's `McpAuditSink` port.
 *
 * Failure (D-8, §3.11): nothing is swallowed. A failed insert emits ONE critical structured line —
 * `audit.write_failed`, the p1 alert of master §117, with no before/after values or reason in it —
 * and the error is rethrown, so the request fails exactly as it did before this spec. Domain modules
 * keep their existing post-commit ordering; MCP stays audit-first because its sink throws.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { isUuid } from '@/lib/offers/validation';
import type { AuditActorType } from '@/lib/types/audit';
import { getRequestCorrelationId } from '@/lib/audit/request-context';

/** Spec 004's correlation-id shape (`lib/api/correlation-id.ts`), mirrored by the column CHECK. */
const CORRELATION_ID_FORMAT = /^[A-Za-z0-9_-]{1,100}$/;

export interface AuditEntryInput {
  actorType: AuditActorType;
  /** Null only for a `system` actor. */
  actorUserId: string | null;
  actorRoles: string[];
  eventType: string;
  resource: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** `admin_actions.id` of the spec 009 `AdminAction` this entry belongs to, when there is one. */
  approvalRef?: string | null;
  approvalChain?: unknown;
  isEmergencyBypass?: boolean;
  /** An explicit correlation id; wins over the request context (D-6). */
  correlationId?: string | null;
}

/**
 * D-6 precedence: the caller's explicit id, else the current request's (X-1 context), else `null`.
 * An explicit id that does not match spec 004's format is not stored as-is — it would violate the
 * column CHECK — so the request context is used instead.
 */
export function resolveCorrelationId(explicit: string | null | undefined): string | null {
  if (typeof explicit === 'string' && CORRELATION_ID_FORMAT.test(explicit)) return explicit;
  return getRequestCorrelationId();
}

/**
 * `approval_ref`: the explicit `approvalRef`, else an `adminActionId` recorded in the approval chain
 * (spec 038's chains carry one). Only a uuid is ever used — the FK to `admin_actions` does the rest.
 */
export function resolveApprovalRef(approvalRef: string | null | undefined, approvalChain: unknown): string | null {
  if (typeof approvalRef === 'string' && isUuid(approvalRef)) return approvalRef;
  if (approvalChain && typeof approvalChain === 'object' && !Array.isArray(approvalChain)) {
    const candidate = (approvalChain as { adminActionId?: unknown }).adminActionId;
    if (typeof candidate === 'string' && isUuid(candidate)) return candidate;
  }
  return null;
}

/**
 * Before/after are "recorded only when provided" (spec 037 AC-5 X-1): a value the caller did not
 * pass is SQL `NULL`, while an explicit `null` — "there was no previous value" — is stored as the JSON
 * value `null`. Both read back as `null` in the DTO, but the stored record keeps the distinction.
 */
export function toJsonbValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return sql`'null'::jsonb`;
  return value;
}

/** Writes one immutable `audit_logs` row and returns its id. Throws (after signalling) on failure. */
export async function writeAuditEntry(input: AuditEntryInput): Promise<string> {
  const correlationId = resolveCorrelationId(input.correlationId);
  try {
    const [row] = await getDb()
      .insert(auditLogs)
      .values({
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        actorRoles: input.actorRoles,
        eventType: input.eventType,
        resource: input.resource,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        reason: input.reason ?? null,
        beforeValue: toJsonbValue(input.before),
        afterValue: toJsonbValue(input.after),
        approvalRef: resolveApprovalRef(input.approvalRef, input.approvalChain),
        approvalChain: input.approvalChain ?? [],
        isEmergencyBypass: input.isEmergencyBypass ?? false,
        correlationId,
      })
      .returning({ id: auditLogs.id });
    return row!.id;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'audit.write_failed',
        severity: 'critical',
        eventType: input.eventType,
        resource: input.resource,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      }),
    );
    throw err;
  }
}
