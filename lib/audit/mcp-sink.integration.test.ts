import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMcpAuditSink } from '@/lib/mcp/audit';
import { authorizeAndExecute } from '@/lib/mcp/authorize';
import { authContext, registerTestTool, resetMcpTestState, trace } from '@/lib/mcp/mcp-test-support';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { runWithRequestContext } from '@/lib/audit/request-context';
import { durableMcpAuditSink, MCP_AUDIT_EVENT_TYPE } from './mcp-sink';
import { registerAuditIntegration } from './register';
import { auditRowsByEventType, isDatabaseReachable } from './audit-test-support';
import { getDb } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 039 §3.6 (AC-5 for spec 035 AC-1 check 8) — the durable sink behind spec 035's port. An MCP
 * tool call is the user's own action (`user`, `mcp.tool_call`); the write happens BEFORE the tool
 * runs, and a write that cannot be made blocks the tool.
 */
describe.skipIf(!dbReachable)('durable MCP audit sink (spec 039 §3.6)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    resetMcpTestState();
    registerAuditIntegration();
  });
  afterEach(() => resetMcpTestState());

  it('registerAuditIntegration installs the durable sink (idempotently)', () => {
    registerAuditIntegration();
    expect(getMcpAuditSink()).toBe(durableMcpAuditSink);
  });

  it('a tool call through spec 035 writes one user-actor row before executing, with the request correlation id', async () => {
    const user = await registerAndLogin();
    const toolName = `spec039_tool_${randomUUID().slice(0, 8)}`;
    registerTestTool({ name: toolName });
    const context = authContext({ userId: user.userId });

    const result = await runWithRequestContext({ correlationId: 'mcp-corr-39' }, () =>
      authorizeAndExecute({ toolName, rawInput: { note: 'private note text' } }, context),
    );

    expect(result.success).toBe(true);
    expect(trace.indexOf('execute')).toBeGreaterThan(-1);
    const [row] = await getDb().select().from(auditLogs).where(eq(auditLogs.id, result.auditId!));
    expect(row).toMatchObject({
      actorType: 'user',
      actorUserId: user.userId,
      actorRoles: [],
      eventType: MCP_AUDIT_EVENT_TYPE,
      resource: 'mcp',
      action: 'tool_call',
      targetType: 'mcp_tool',
      targetId: toolName,
      correlationId: 'mcp-corr-39',
      afterValue: { riskTier: 'low', confirmed: false, reversible: true, sessionId: context.sessionId },
    });
    // No tool input is ever recorded (spec 035's rule).
    expect(JSON.stringify(row)).not.toContain('private note text');
  });

  it('a durable write that cannot be made blocks the tool (audit-first preserved)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toolName = `spec039_blocked_${randomUUID().slice(0, 8)}`;
    registerTestTool({ name: toolName });
    // A user id with no `users` row: the FK refuses the insert, so the audit write fails for real.
    await expect(authorizeAndExecute({ toolName, rawInput: { note: 'x' } }, authContext({ userId: randomUUID() }))).rejects.toThrow();
    expect(trace).not.toContain('execute');
    expect(error.mock.calls.some(([line]) => String(line).includes('"event":"audit.write_failed"'))).toBe(true);
    error.mockRestore();
  });

  it('record() returns the new row id as the auditId, and outside a request the correlation id is null', async () => {
    const user = await registerAndLogin();
    const auditId = await durableMcpAuditSink.record({
      toolName: 'direct_record',
      riskTier: 'medium',
      userId: user.userId,
      sessionId: 'session-1',
      confirmed: true,
      reversible: false,
    });
    const rows = await auditRowsByEventType(MCP_AUDIT_EVENT_TYPE);
    const row = rows.find((r) => r.id === auditId);
    expect(row).toMatchObject({ targetId: 'direct_record', correlationId: null, afterValue: { riskTier: 'medium', confirmed: true, reversible: false, sessionId: 'session-1' } });
  });
});
