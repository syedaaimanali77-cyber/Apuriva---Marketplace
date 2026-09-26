/**
 * Spec 039 §5 — pure helpers for the audit log page, kept out of `page.tsx` because an App Router
 * page may only export its default component (and Next's reserved fields).
 */

/** The L1 filters (spec 039 §3.8). Kept as strings so a failed load never loses what was typed. */
export interface AuditLogFilters {
  resource: string;
  eventType: string;
  actorUserId: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AuditLogFilters = {
  resource: '',
  eventType: '',
  actorUserId: '',
  targetType: '',
  targetId: '',
  correlationId: '',
  from: '',
  to: '',
};

export const FILTER_FIELDS: { key: keyof AuditLogFilters; label: string; type?: string }[] = [
  { key: 'resource', label: 'Resource' },
  { key: 'eventType', label: 'Event type' },
  { key: 'actorUserId', label: 'Actor user id' },
  { key: 'targetType', label: 'Target type' },
  { key: 'targetId', label: 'Target id' },
  { key: 'correlationId', label: 'Correlation id' },
  { key: 'from', label: 'From', type: 'datetime-local' },
  { key: 'to', label: 'To', type: 'datetime-local' },
];

export const PAGE_SIZE = 20;

/** Builds the L1 query string: only non-empty filters; local date-times become ISO instants. */
export function buildAuditQuery(filters: AuditLogFilters, offset: number): string {
  const params = new URLSearchParams();
  for (const { key, type } of FILTER_FIELDS) {
    const value = filters[key].trim();
    if (!value) continue;
    const parsed = type === 'datetime-local' ? new Date(value) : null;
    params.set(key, parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : value);
  }
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  return params.toString();
}

/** Before/after values rendered as formatted JSON (spec 039 D-10) — no diff component exists. */
export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value, null, 2);
}
