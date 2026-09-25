/**
 * Spec 037 §3 "Operations queue" (AC-2) — one read-only queue over three existing sources.
 *
 * "Needing attention" = NOT in the source's own terminal state(s). Each source is included only
 * for a caller holding that source's EXISTING read permission; a source the caller cannot read
 * contributes nothing and is not mentioned. The three per-queue listers are not called (each
 * applies its own paging); this module reads only id/status/priority/created_at, writes nothing
 * and marks nothing as seen. No free-text column is ever selected (D-10).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { PageParams } from '@/lib/api/pagination';
import { queryRows, type Executor } from '@/lib/offers/db';
import { DISPUTES_READ_ACTION, DISPUTES_RESOURCE } from '@/lib/disputes/permissions';
import { SAFETY_READ_ACTION, SAFETY_RESOURCE } from '@/lib/safety/permissions';
import { SUPPORT_READ_ACTION, SUPPORT_RESOURCE } from '@/lib/support/permissions';
import type {
  OperationsQueueItemDto,
  OperationsQueueItemType,
  OperationsQueuePriority,
} from '@/lib/types/admin-dashboard';
import { holdsPermission, requireAnyAdminRole } from './access';

/** Which sources a caller may read — each resolved from its own existing permission seed. */
export interface QueueSources {
  disputes: boolean;
  supportTickets: boolean;
  safetyReports: boolean;
}

export async function queueSourcesFor(userId: string): Promise<QueueSources> {
  const [disputes, supportTickets, safetyReports] = await Promise.all([
    holdsPermission(userId, DISPUTES_RESOURCE, DISPUTES_READ_ACTION),
    holdsPermission(userId, SUPPORT_RESOURCE, SUPPORT_READ_ACTION),
    holdsPermission(userId, SAFETY_RESOURCE, SAFETY_READ_ACTION),
  ]);
  return { disputes, supportTickets, safetyReports };
}

/** Priority rank for ordering: critical > high > medium > low > null (disputes) — D-18. */
export const PRIORITY_RANK: Record<OperationsQueuePriority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function priorityRank(priority: OperationsQueuePriority | null): number {
  return priority === null ? 0 : PRIORITY_RANK[priority];
}

/**
 * The queue's total order, as a comparator: priority descending, then `createdAt` ascending (spec
 * 030's queue order, `null` last), then `id` so paging is stable among exact ties. The SQL below
 * implements the same order; this function is its unit-testable statement.
 */
export function compareQueueItems(a: OperationsQueueItemDto, b: OperationsQueueItemDto): number {
  return (
    priorityRank(b.priority) - priorityRank(a.priority) ||
    byteOrder(a.createdAt, b.createdAt) ||
    byteOrder(a.id, b.id)
  );
}

/** Plain code-unit order — what Postgres uses for ISO timestamps and lowercase-hex UUIDs alike. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function queueLinkFor(type: OperationsQueueItemType, id: string): string {
  switch (type) {
    case 'dispute':
      return `/admin/operations/disputes/${id}`;
    case 'support_ticket':
      return `/admin/operations/support/${id}`;
    case 'safety_report':
      // Spec 030 ships a queue page only; there is no per-report admin route.
      return '/admin/operations/safety';
  }
}

/** One SELECT per permitted source, each already restricted to its non-terminal states. */
function sourceSelects(sources: QueueSources): SQL[] {
  const parts: SQL[] = [];
  if (sources.disputes) {
    parts.push(sql`SELECT 'dispute'::text AS type, id, status, NULL::text AS priority, created_at
                     FROM disputes WHERE status NOT IN ('resolved', 'closed')`);
  }
  if (sources.supportTickets) {
    parts.push(sql`SELECT 'support_ticket'::text AS type, id, status, priority, created_at
                     FROM support_tickets WHERE status NOT IN ('resolved', 'closed')`);
  }
  if (sources.safetyReports) {
    parts.push(sql`SELECT 'safety_report'::text AS type, id, status, priority, created_at
                     FROM safety_reports WHERE status <> 'resolved'`);
  }
  return parts;
}

interface QueueRow {
  type: OperationsQueueItemType;
  id: string;
  status: string;
  priority: OperationsQueuePriority | null;
  created_at: Date | string;
}

export async function readOperationsQueue(
  db: Executor,
  sources: QueueSources,
  page: PageParams,
): Promise<{ items: OperationsQueueItemDto[]; total: number }> {
  const parts = sourceSelects(sources);
  if (parts.length === 0) return { items: [], total: 0 };
  const union = sql.join(parts, sql` UNION ALL `);

  const rows = await queryRows<QueueRow>(
    db,
    sql`SELECT q.type, q.id, q.status, q.priority, q.created_at
          FROM (${union}) q
         ORDER BY CASE q.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2
                                  WHEN 'low' THEN 1 ELSE 0 END DESC,
                  q.created_at ASC, q.id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: number }>(db, sql`SELECT count(*)::int AS total FROM (${union}) q`);

  return {
    items: rows.map((row) => ({
      type: row.type,
      id: row.id,
      status: row.status,
      priority: row.priority,
      createdAt: new Date(row.created_at).toISOString(),
      linkTo: queueLinkFor(row.type, row.id),
    })),
    total: count?.total ?? 0,
  };
}

/** `GET /api/v1/admin/operations/queue` (AC-2, AC-6). Any admin role; sources per permission. */
export async function getOperationsQueue(
  userId: string,
  page: PageParams,
  options: { db?: Executor } = {},
): Promise<{ items: OperationsQueueItemDto[]; total: number }> {
  await requireAnyAdminRole(userId);
  return readOperationsQueue(options.db ?? getDb(), await queueSourcesFor(userId), page);
}
