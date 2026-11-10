/**
 * Spec 035 test support. Shared by this spec's suites only.
 *
 * The test tools below are exactly that — TEST tools. This spec registers no business tool
 * (spec 036 owns the catalogue), and `boundary.test.ts` asserts that the shipped registries are
 * empty, so nothing here can quietly become a real one.
 */
import { randomUUID } from 'node:crypto';
import { registerMcpTool, resetMcpRegistryForTests } from './registry';
import { resetMcpAuditSinkForTests, registerMcpAuditSink, type McpAuditEntry } from './audit';
import { requireExactFields, requireString } from './validation';
import type { McpAuthContext, McpToolDefinition } from './types';

export { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
/** The shared helper (`lib/db/test-support.ts`), not a second implementation of the same check. */
export { isDatabaseReachable } from '@/lib/db/test-support';

export function authContext(overrides: Partial<McpAuthContext> = {}): McpAuthContext {
  return {
    userId: randomUUID(),
    sessionId: randomUUID(),
    activeMode: 'customer',
    isAdmin: false,
    ...overrides,
  };
}

/** Records which checks a call actually reached, so a suite can assert the ORDER of the eight. */
export const trace: string[] = [];

export function resetMcpTestState(): void {
  resetMcpRegistryForTests();
  resetMcpAuditSinkForTests();
  trace.length = 0;
}

/** A capturing audit sink, so a suite can assert check 8 ran and what it recorded. */
export function captureAudit(): McpAuditEntry[] {
  const entries: McpAuditEntry[] = [];
  registerMcpAuditSink({
    async record(entry) {
      trace.push('audit_requirement');
      entries.push(entry);
      return randomUUID();
    },
  });
  return entries;
}

/** An audit sink that cannot write — check 8 must then block execution. */
export function failingAudit(): void {
  registerMcpAuditSink({
    async record() {
      throw new Error('audit unavailable');
    },
  });
}

export interface TestToolOptions {
  name?: string;
  riskTier?: McpToolDefinition['riskTier'];
  adminOnly?: boolean;
  modes?: McpToolDefinition['modes'];
  permission?: { resource: string; action: string };
  ownsResource?: boolean;
  contextValid?: boolean;
  reversible?: boolean;
  withOwnershipCheck?: boolean;
  withContextCheck?: boolean;
}

/**
 * A minimal tool whose only job is to record that it ran. `ownsResource`/`contextValid` stand in
 * for the owning domain module's answer — the pipeline asks, exactly as it would ask bookings or
 * requests, and never decides ownership itself.
 */
export function registerTestTool(options: TestToolOptions = {}): McpToolDefinition<{ note: string }, { ran: true }> {
  const riskTier = options.riskTier ?? 'low';
  const tool: McpToolDefinition<{ note: string }, { ran: true }> = {
    name: options.name ?? 'test_tool',
    riskTier,
    label: 'Test tool',
    reversible: options.reversible ?? true,
    adminOnly: options.adminOnly ?? false,
    modes: options.modes ?? (['customer', 'provider'] as const),
    permission: options.permission,
    requiresConfirmation: riskTier === 'medium' || riskTier === 'high',
    isIdempotent: true,
    validate(raw) {
      trace.push('validate');
      const input = requireExactFields(raw, ['note']);
      return { note: input.note === undefined ? '' : requireString(input, 'note', { maxLength: 200 }) };
    },
    execute: async () => {
      trace.push('execute');
      return { ran: true };
    },
  };

  if (options.withOwnershipCheck !== false) {
    tool.checkOwnership = async () => {
      trace.push('resource_ownership');
      return { ok: options.ownsResource ?? true, reason: 'test ownership' };
    };
  }
  if (options.withContextCheck !== false) {
    tool.checkContext = async () => {
      trace.push('booking_request_context');
      return { ok: options.contextValid ?? true, reason: 'test context' };
    };
  }

  registerMcpTool(tool);
  return tool;
}
