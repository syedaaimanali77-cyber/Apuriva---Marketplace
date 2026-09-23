/**
 * Spec 035 §4 "Audit sink" — check 8 of the eight.
 *
 * Spec 039 owns the audit log's schema, coverage and retention, and is sequenced AFTER this spec,
 * so no `audit_log` table exists yet and this spec creates none. Instead this is a PORT, the
 * pattern specs 021, 027, 030 and 034 already use: the default sink records the entry as
 * structured stdout (spec 046's pipeline collects it) and returns its id; spec 039 registers the
 * durable sink when it lands, without a line changing here or in the pipeline.
 *
 * The audit write happens BEFORE the tool executes and is the last check: if it throws, the tool
 * does not run (spec 035 §3, "a tool whose audit write cannot be made does not execute"). An
 * action nobody can account for afterwards is exactly the silent execution master spec §132.21
 * forbids.
 *
 * An entry carries no tool input: see `security-log.ts` for the same rule and its reason.
 */
import { randomUUID } from 'node:crypto';
import type { AiProposedRiskTier } from '@/lib/ai-assistant/risk-policy';

export interface McpAuditEntry {
  toolName: string;
  riskTier: AiProposedRiskTier;
  userId: string;
  sessionId: string;
  /** Whether this call ran against a confirmation the user had given. */
  confirmed: boolean;
  reversible: boolean;
}

export interface McpAuditSink {
  /** Returns the audit id carried back in `McpToolResult.auditId`. Throws to block execution. */
  record(entry: McpAuditEntry): Promise<string>;
}

const DEFAULT_SINK: McpAuditSink = {
  async record(entry) {
    const auditId = randomUUID();
    console.info(
      JSON.stringify({
        event: 'mcp.tool_call',
        auditId,
        tool: entry.toolName,
        riskTier: entry.riskTier,
        userId: entry.userId,
        confirmed: entry.confirmed,
        reversible: entry.reversible,
        at: new Date().toISOString(),
      }),
    );
    return auditId;
  },
};

let currentSink: McpAuditSink = DEFAULT_SINK;

/** Called once by spec 039 at startup to make the audit trail durable. */
export function registerMcpAuditSink(sink: McpAuditSink): void {
  currentSink = sink;
}

export function getMcpAuditSink(): McpAuditSink {
  return currentSink;
}

/** Test-only: restores the default sink so suites cannot leak into each other. */
export function resetMcpAuditSinkForTests(): void {
  currentSink = DEFAULT_SINK;
}
