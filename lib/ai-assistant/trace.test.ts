import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '@/lib/audit/request-context';
import { getMcpAuditSink, resetMcpAuditSinkForTests } from '@/lib/mcp/audit';
import { logMcpAuthorizationFailure } from '@/lib/mcp/security-log';
import { sendTurn } from './turns';

/**
 * Spec 046 §3.9 X-7 — the AI request trace (master §117: User → AI → MCP tool → authorization →
 * backend → result → AI response) is queryable by the request's correlation ID. The backend → result
 * step is spec 039's durable audit row, which already carries it (lib/audit/*.test.ts).
 */
const CORRELATION_ID = 'trace-corr-1';
const originalOverride = process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;

const parsed = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

describe('AI request trace (spec 046 X-7)', () => {
  beforeEach(() => {
    resetMcpAuditSinkForTests();
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED;
    else process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED = originalOverride;
    vi.restoreAllMocks();
  });

  it('User → AI and → AI response: ai.turn_started / ai.turn_completed carry the correlation ID and never the text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    // The assistant is switched off, so the turn fails at its first step — before any database or AI call.
    process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED = 'false';
    const ctx = { userId: 'u-1', sessionId: 's-1', conversationId: 'c-1' };

    await expect(
      runWithRequestContext({ correlationId: CORRELATION_ID }, () => sendTurn(ctx, 'key-1', { body: 'my private question' })),
    ).rejects.toBeTruthy();

    const trace = parsed(info).filter((l) => String(l.event).startsWith('ai.turn_'));
    expect(trace.map((l) => l.event)).toEqual(['ai.turn_started', 'ai.turn_completed']);
    expect(trace.every((l) => l.correlationId === CORRELATION_ID && l.conversationId === 'c-1')).toBe(true);
    expect(trace[1]).toMatchObject({ outcome: 'failed' });
    expect(typeof trace[1]!.durationMs).toBe('number');
    expect(JSON.stringify(trace)).not.toContain('private question');
  });

  it('AI → MCP tool: the default mcp.tool_call line carries the correlation ID', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await runWithRequestContext({ correlationId: CORRELATION_ID }, () =>
      getMcpAuditSink().record({ toolName: 'probe', riskTier: 'low', userId: 'u-1', sessionId: 's-1', confirmed: false, reversible: true }),
    );
    expect(parsed(info).find((l) => l.event === 'mcp.tool_call')).toMatchObject({ correlationId: CORRELATION_ID, tool: 'probe' });
  });

  it('authorization: mcp.authorization_failed carries the correlation ID (and none outside a request)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runWithRequestContext({ correlationId: CORRELATION_ID }, () =>
      logMcpAuthorizationFailure({ toolName: 'probe', check: 'tool_risk', userId: 'u-1', reason: 'r' }),
    );
    logMcpAuthorizationFailure({ toolName: 'probe', check: 'tool_risk', userId: 'u-1', reason: 'r' });
    const [inRequest, outside] = parsed(warn);
    expect(inRequest).toMatchObject({ event: 'mcp.authorization_failed', correlationId: CORRELATION_ID });
    // logEvent adds the ID only when a request is running (§3.9); it never invents one.
    expect(outside).not.toHaveProperty('correlationId');
  });
});
