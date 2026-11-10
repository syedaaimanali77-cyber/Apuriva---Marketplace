/**
 * Spec 039 §3.6 — the DURABLE implementation of spec 035's `McpAuditSink` port (`lib/mcp/audit.ts`).
 * Spec 035 ships a stdout-only default and says spec 039 registers this; nothing in `lib/mcp` changes
 * (spec 035's boundary test forbids the audit table's name there).
 *
 * An MCP tool call is the signed-in USER's action, taken through the assistant under that user's own
 * authorization — there is no `ai` actor (D-7). It is recorded as `actor_type 'user'` with event type
 * `mcp.tool_call`. No tool input is stored (spec 035's rule); `sessionId` and the call's risk facts go
 * in `after_value`. The correlation id comes from the assistant request's context (§3.5).
 *
 * AUDIT-FIRST is preserved: spec 035 calls `record()` BEFORE the tool executes, and a failed write
 * THROWS here, so the tool does not run.
 */
import type { McpAuditSink } from '@/lib/mcp/audit';
import { writeAuditEntry } from './write';

export const MCP_AUDIT_EVENT_TYPE = 'mcp.tool_call';

export const durableMcpAuditSink: McpAuditSink = {
  async record(entry) {
    return writeAuditEntry({
      actorType: 'user',
      actorUserId: entry.userId,
      actorRoles: [],
      eventType: MCP_AUDIT_EVENT_TYPE,
      resource: 'mcp',
      action: 'tool_call',
      targetType: 'mcp_tool',
      targetId: entry.toolName,
      after: {
        riskTier: entry.riskTier,
        confirmed: entry.confirmed,
        reversible: entry.reversible,
        sessionId: entry.sessionId,
      },
    });
  },
};
