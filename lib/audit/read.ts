/**
 * Spec 039 §3.8 — the read side of the audit log (L1 list, L2 detail). Read-only by construction:
 * nothing here writes, and the table's triggers would refuse an UPDATE/DELETE anyway (AC-2).
 *
 * Scope (AC-4) is applied IN SQL, so `total` counts only rows the caller may see and a query
 * parameter can never widen it: an explicit `resource` filter outside scope is `403`, and a detail
 * id outside scope is `404` — indistinguishable from an unknown id, so ids cannot be probed.
 */
import { and, count, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { ApiRouteError, forbiddenError, validationError } from '@/lib/api/errors';
import type { PageParams } from '@/lib/api/pagination';
import { isUuid } from '@/lib/offers/validation';
import type { AuditActorType, AuditLogDto, AuditLogQuery } from '@/lib/types/audit';
import { isResourceInScope, resolveAuditScope, type AuditScope } from './scope';

const CORRELATION_ID_FORMAT = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_TEXT_FILTER = 128;
const TEXT_FILTERS = ['resource', 'eventType', 'targetType', 'targetId'] as const;

function notFound(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'Audit entry not found.');
}

function parseInstant(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parses and validates L1's filters (§3.8). Every problem is reported at once as `400`. */
export function parseAuditLogQuery(params: URLSearchParams): AuditLogQuery {
  const errors: { field: string; message: string }[] = [];
  const query: AuditLogQuery = {};

  const actorUserId = params.get('actorUserId');
  if (actorUserId !== null) {
    if (isUuid(actorUserId)) query.actorUserId = actorUserId;
    else errors.push({ field: 'actorUserId', message: 'Must be a uuid.' });
  }
  for (const field of TEXT_FILTERS) {
    const value = params.get(field);
    if (value === null) continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_FILTER) {
      errors.push({ field, message: `Must be 1-${MAX_TEXT_FILTER} characters.` });
    } else {
      query[field] = trimmed;
    }
  }
  const correlationId = params.get('correlationId');
  if (correlationId !== null) {
    if (CORRELATION_ID_FORMAT.test(correlationId)) query.correlationId = correlationId;
    else errors.push({ field: 'correlationId', message: 'Must match the correlation-id format.' });
  }
  let from: Date | null = null;
  let to: Date | null = null;
  const rawFrom = params.get('from');
  if (rawFrom !== null) {
    from = parseInstant(rawFrom);
    if (from) query.from = from.toISOString();
    else errors.push({ field: 'from', message: 'Must be an ISO-8601 instant.' });
  }
  const rawTo = params.get('to');
  if (rawTo !== null) {
    to = parseInstant(rawTo);
    if (to) query.to = to.toISOString();
    else errors.push({ field: 'to', message: 'Must be an ISO-8601 instant.' });
  }
  if (from && to && from.getTime() >= to.getTime()) {
    errors.push({ field: 'from', message: 'Must be earlier than `to`.' });
  }

  if (errors.length > 0) throw validationError(errors);
  return query;
}

type AuditRow = typeof auditLogs.$inferSelect;

export function toAuditLogDto(row: AuditRow): AuditLogDto {
  return {
    id: row.id,
    actorType: row.actorType as AuditActorType,
    actorUserId: row.actorUserId,
    actorRoles: Array.isArray(row.actorRoles) ? (row.actorRoles as string[]) : [],
    eventType: row.eventType,
    resource: row.resource,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    beforeValue: row.beforeValue ?? null,
    afterValue: row.afterValue ?? null,
    reason: row.reason,
    approvalRef: row.approvalRef,
    approvalChain: row.approvalChain,
    isEmergencyBypass: row.isEmergencyBypass,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The scope condition, or `null` for super_admin (no restriction). Called with a non-empty scope. */
function scopeCondition(scope: AuditScope): SQL | null {
  return scope.all ? null : inArray(auditLogs.resource, scope.resources);
}

/** L1 — the caller's visible entries, newest first, filtered and paged. */
export async function listAuditLogs(
  viewerUserId: string,
  query: AuditLogQuery,
  page: PageParams,
): Promise<{ rows: AuditLogDto[]; total: number; scope: AuditScope }> {
  const scope = await resolveAuditScope(viewerUserId);
  if (query.resource !== undefined && !isResourceInScope(scope, query.resource)) {
    throw forbiddenError('That resource is outside your audit-log scope.');
  }
  // A role that maps to no audited resource today (analytics_admin) sees an empty log, not an error.
  if (!scope.all && scope.resources.length === 0) return { rows: [], total: 0, scope };

  const conditions: SQL[] = [];
  const scoped = scopeCondition(scope);
  if (scoped) conditions.push(scoped);
  if (query.actorUserId) conditions.push(eq(auditLogs.actorUserId, query.actorUserId));
  if (query.resource) conditions.push(eq(auditLogs.resource, query.resource));
  if (query.eventType) conditions.push(eq(auditLogs.eventType, query.eventType));
  if (query.targetType) conditions.push(eq(auditLogs.targetType, query.targetType));
  if (query.targetId) conditions.push(eq(auditLogs.targetId, query.targetId));
  if (query.correlationId) conditions.push(eq(auditLogs.correlationId, query.correlationId));
  if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lt(auditLogs.createdAt, new Date(query.to)));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const db = getDb();
  const [totals] = await db.select({ total: count() }).from(auditLogs).where(where);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(page.limit)
    .offset(page.offset);
  return { rows: rows.map(toAuditLogDto), total: Number(totals?.total ?? 0), scope };
}

/** L2 — one entry. Unknown and out-of-scope ids are the same `404`. */
export async function getAuditLog(viewerUserId: string, id: string): Promise<AuditLogDto> {
  const scope = await resolveAuditScope(viewerUserId);
  if (!isUuid(id)) throw notFound();
  const [row] = await getDb().select().from(auditLogs).where(eq(auditLogs.id, id));
  if (!row || !isResourceInScope(scope, row.resource)) throw notFound();
  return toAuditLogDto(row);
}
