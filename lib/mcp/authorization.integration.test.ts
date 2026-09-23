import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { MCP_AUTHORIZATION_CHECKS, authorizeAndExecute } from './authorize';
import { MCP_AUTHORIZATION_FAILED, MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT } from './errors';
import { authContext, captureAudit, failingAudit, registerTestTool, resetMcpTestState, trace } from './mcp-test-support';

/**
 * Spec 035 AC-1 / AC-2 — the eight checks, their ORDER, and that each one blocks (master spec §89).
 *
 * These run without a database: a low-risk tool with no admin permission touches neither the
 * confirmation table nor spec 009's resolver. The checks that do need one are covered in
 * `confirmation.integration.test.ts` and `security.integration.test.ts`.
 */
describe('spec 035 eight-step authorization', () => {
  beforeEach(resetMcpTestState);
  afterEach(resetMcpTestState);

  it('AC-1: the eight checks are declared in master spec §89 order', () => {
    expect([...MCP_AUTHORIZATION_CHECKS]).toEqual([
      'authenticated_identity',
      'role_mode',
      'resource_ownership',
      'booking_request_context',
      'tool_risk',
      'required_confirmation',
      'permission_scope',
      'audit_requirement',
    ]);
  });

  it('AC-1: a passing call runs ownership, then context, then audit, then the tool — in that order', async () => {
    const audits = captureAudit();
    registerTestTool({ name: 'ordered_tool' });

    const result = await authorizeAndExecute({ toolName: 'ordered_tool', rawInput: { note: 'hi' } }, authContext());

    expect(result.success).toBe(true);
    expect(result.auditId).toBeTruthy();
    // validate precedes every check that reads input; audit is the LAST check and still precedes execution.
    expect(trace).toEqual(['validate', 'resource_ownership', 'booking_request_context', 'audit_requirement', 'execute']);
    expect(audits).toHaveLength(1);
  });

  it('AC-1 check 1: no authenticated identity blocks the call before the tool is even looked up', async () => {
    captureAudit();
    registerTestTool({ name: 'identity_tool' });

    await expect(
      authorizeAndExecute({ toolName: 'identity_tool', rawInput: { note: 'hi' } }, authContext({ userId: '' })),
    ).rejects.toThrow(ApiRouteError);
    expect(trace).toEqual([]);
  });

  it('AC-1 check 2: a tool not available in the caller mode is refused', async () => {
    captureAudit();
    registerTestTool({ name: 'provider_tool', modes: ['provider'] });

    const error = await authorizeAndExecute(
      { toolName: 'provider_tool', rawInput: { note: 'hi' } },
      authContext({ activeMode: 'customer' }),
    ).catch((err: ApiRouteError) => err);

    expect((error as ApiRouteError).code).toBe(MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT);
    expect((error as ApiRouteError).status).toBe(403);
    expect(trace).not.toContain('execute');
  });

  it('AC-1 check 3: a failed ownership answer blocks execution and never reaches context', async () => {
    captureAudit();
    registerTestTool({ name: 'owned_tool', ownsResource: false });

    await expect(authorizeAndExecute({ toolName: 'owned_tool', rawInput: { note: 'hi' } }, authContext())).rejects.toThrow(
      ApiRouteError,
    );
    expect(trace).toEqual(['validate', 'resource_ownership']);
  });

  it('AC-1 check 4: an invalid booking/request context blocks execution', async () => {
    captureAudit();
    registerTestTool({ name: 'context_tool', contextValid: false });

    await expect(authorizeAndExecute({ toolName: 'context_tool', rawInput: { note: 'hi' } }, authContext())).rejects.toThrow(
      ApiRouteError,
    );
    expect(trace).toEqual(['validate', 'resource_ownership', 'booking_request_context']);
  });

  it('AC-1 check 5: a restricted tier is refused — never executed, whatever else passes', async () => {
    captureAudit();
    registerTestTool({ name: 'restricted_tool', riskTier: 'restricted' });

    const error = await authorizeAndExecute({ toolName: 'restricted_tool', rawInput: { note: 'hi' } }, authContext()).catch(
      (err: ApiRouteError) => err,
    );

    expect((error as ApiRouteError).code).toBe(MCP_AUTHORIZATION_FAILED);
    expect(trace).not.toContain('execute');
    expect(trace).not.toContain('audit_requirement');
  });

  it('AC-1 check 6: a tool that needs confirmation refuses when none is presented', async () => {
    captureAudit();
    registerTestTool({ name: 'confirm_tool', riskTier: 'high' });

    await expect(authorizeAndExecute({ toolName: 'confirm_tool', rawInput: { note: 'hi' } }, authContext())).rejects.toThrow(
      ApiRouteError,
    );
    expect(trace).not.toContain('execute');
  });

  it('AC-1 check 8: if the audit entry cannot be written, the tool does not run', async () => {
    registerTestTool({ name: 'audited_tool' });
    failingAudit();

    await expect(authorizeAndExecute({ toolName: 'audited_tool', rawInput: { note: 'hi' } }, authContext())).rejects.toThrow(
      ApiRouteError,
    );
    expect(trace).not.toContain('execute');
  });

  it('AC-1: the audit entry records the tool, tier, reversibility and whether it was confirmed', async () => {
    const audits = captureAudit();
    registerTestTool({ name: 'recorded_tool', reversible: false });
    const context = authContext();

    await authorizeAndExecute({ toolName: 'recorded_tool', rawInput: { note: 'hi' } }, context);

    expect(audits[0]).toMatchObject({
      toolName: 'recorded_tool',
      riskTier: 'low',
      userId: context.userId,
      sessionId: context.sessionId,
      confirmed: false,
      reversible: false,
    });
  });

  it('AC-2: an unknown tool is refused rather than executed as something else', async () => {
    captureAudit();
    registerTestTool({ name: 'real_tool' });

    const error = await authorizeAndExecute({ toolName: 'imagined_tool', rawInput: {} }, authContext()).catch(
      (err: ApiRouteError) => err,
    );

    expect((error as ApiRouteError).code).toBe(MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT);
    expect(trace).toEqual([]);
  });

  it('AC-2: every refusal message is identical, so the pipeline is not an oracle', async () => {
    captureAudit();
    registerTestTool({ name: 'oracle_a', ownsResource: false });
    registerTestTool({ name: 'oracle_b', contextValid: false });

    const first = await authorizeAndExecute({ toolName: 'oracle_a', rawInput: { note: 'x' } }, authContext()).catch(
      (err: ApiRouteError) => err,
    );
    const second = await authorizeAndExecute({ toolName: 'oracle_b', rawInput: { note: 'x' } }, authContext()).catch(
      (err: ApiRouteError) => err,
    );

    expect((first as ApiRouteError).message).toBe((second as ApiRouteError).message);
    expect((first as ApiRouteError).code).toBe((second as ApiRouteError).code);
  });
});
