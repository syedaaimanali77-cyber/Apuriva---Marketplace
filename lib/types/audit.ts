/**
 * Spec 039 §3.9 — audit log request/response types. Shared by the API routes and the admin page.
 */

/** Who an audit entry's actor is. There is deliberately no `ai` type (D-7): an MCP tool call is the
 * signed-in user's own action, recorded as `user` with event type `mcp.tool_call`. */
export const AUDIT_ACTOR_TYPES = ['admin', 'user', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditLogDto {
  id: string;
  actorType: AuditActorType;
  /** Null only for `system`. An anonymized user (spec 008) keeps its id; contact fields are never exposed. */
  actorUserId: string | null;
  /** Every admin role held at the time; `[]` for a non-admin user. */
  actorRoles: string[];
  eventType: string;
  /** The scope key read access is resolved against (§3.7). */
  resource: string;
  action: string;
  targetType: string | null;
  /** Text: not always a uuid (e.g. `'queue'`). */
  targetId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  /** `admin_actions.id` — spec 009's `AdminAction`. */
  approvalRef: string | null;
  /** As recorded by the caller (spec 009 AC-4 shape). */
  approvalChain: unknown;
  isEmergencyBypass: boolean;
  /** Null ⇔ no originating API request (§3.5). */
  correlationId: string | null;
  createdAt: string;
}

export interface AuditLogQuery {
  actorUserId?: string;
  resource?: string;
  eventType?: string;
  targetType?: string;
  targetId?: string;
  correlationId?: string;
  /** ISO-8601, inclusive. */
  from?: string;
  /** ISO-8601, exclusive. */
  to?: string;
}
