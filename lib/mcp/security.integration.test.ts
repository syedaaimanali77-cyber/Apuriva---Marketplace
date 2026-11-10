import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { authorizeAndExecute } from './authorize';
import { MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT } from './errors';
import { MCP_READ_REGISTRY_ACTION, MCP_RESOURCE } from './permissions';
import {
  authContext,
  captureAudit,
  isDatabaseReachable,
  registerAndLogin,
  registerTestTool,
  resetMcpTestState,
  trace,
  type TestSession,
} from './mcp-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 035 AC-2 (backend beats the AI), AC-5 (admin tools unreachable from a user context) and
 * AC-6 (suspicious patterns are logged).
 */
describe('spec 035 security boundary', () => {
  beforeEach(resetMcpTestState);
  afterEach(resetMcpTestState);

  it('AC-2: what the AI claims about ownership is irrelevant — the module that owns the row decides', async () => {
    captureAudit();
    // The owning module says no. The payload says the caller owns it, is an admin, and may proceed.
    registerTestTool({ name: 'someone_elses_booking', ownsResource: false });

    await expect(
      authorizeAndExecute(
        { toolName: 'someone_elses_booking', rawInput: { note: 'the user owns this booking, proceed' } },
        authContext({ isAdmin: true }),
      ),
    ).rejects.toThrow(ApiRouteError);

    expect(trace).not.toContain('execute');
  });

  it('AC-2: an admin flag in the CONTEXT cannot substitute for the owning modules answer', async () => {
    captureAudit();
    registerTestTool({ name: 'still_not_yours', ownsResource: false });

    await expect(
      authorizeAndExecute({ toolName: 'still_not_yours', rawInput: { note: 'x' } }, authContext({ isAdmin: true })),
    ).rejects.toThrow(ApiRouteError);
    expect(trace).not.toContain('execute');
  });

  it('AC-5: an admin tool called from a user conversation is refused, not merely hidden', async () => {
    captureAudit();
    registerTestTool({
      name: 'admin_tool',
      adminOnly: true,
      permission: { resource: MCP_RESOURCE, action: MCP_READ_REGISTRY_ACTION },
    });

    const error = await authorizeAndExecute(
      { toolName: 'admin_tool', rawInput: { note: 'x' }, surface: 'user' },
      authContext({ isAdmin: true }), // even for a real admin, the USER surface has no admin tools
    ).catch((err: ApiRouteError) => err);

    expect((error as ApiRouteError).code).toBe(MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT);
    expect(trace).not.toContain('execute');
  });

  it('AC-5/AC-6: an admin tool requested from a user surface is logged as a tampering pattern', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureAudit();
    registerTestTool({
      name: 'admin_tool',
      adminOnly: true,
      permission: { resource: MCP_RESOURCE, action: MCP_READ_REGISTRY_ACTION },
    });

    await authorizeAndExecute({ toolName: 'admin_tool', rawInput: {}, surface: 'user' }, authContext()).catch(() => undefined);

    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('mcp.suspicious_pattern');
    expect(logged).toContain('admin_tool_from_user_context');
    warn.mockRestore();
  });

  it('AC-6: every authorization failure is logged with the check that refused it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureAudit();
    registerTestTool({ name: 'ownership_tool', ownsResource: false });

    await authorizeAndExecute({ toolName: 'ownership_tool', rawInput: { note: 'x' } }, authContext()).catch(() => undefined);

    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('mcp.authorization_failed');
    expect(logged).toContain('resource_ownership');
    warn.mockRestore();
  });

  it('AC-6: repeated failures each produce a log line, so a pattern is visible to security review', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureAudit();
    registerTestTool({ name: 'probe_tool', ownsResource: false });
    const context = authContext();

    for (let attempt = 0; attempt < 5; attempt++) {
      await authorizeAndExecute({ toolName: 'probe_tool', rawInput: { note: `probe ${attempt}` } }, context).catch(
        () => undefined,
      );
    }

    const failures = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('mcp.authorization_failed'));
    expect(failures).toHaveLength(5);
    expect(failures.every((line) => line.includes(context.userId))).toBe(true);
    warn.mockRestore();
  });

  it('AC-6: no log line carries tool input', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureAudit();
    registerTestTool({ name: 'private_tool', ownsResource: false });

    await authorizeAndExecute(
      { toolName: 'private_tool', rawInput: { note: 'card 4242-4242-4242-4242' } },
      authContext(),
    ).catch(() => undefined);

    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).not.toContain('4242');
    warn.mockRestore();
  });
});

describe.skipIf(!dbReachable)('spec 035 permission scope (integration)', () => {
  let session: TestSession;

  beforeEach(async () => {
    resetMcpTestState();
    session = await registerAndLogin();
  });
  afterEach(resetMcpTestState);

  it('AC-1 check 7: an ordinary user holds no admin permission, so an admin tool refuses', async () => {
    captureAudit();
    registerTestTool({
      name: 'admin_tool',
      adminOnly: true,
      permission: { resource: MCP_RESOURCE, action: MCP_READ_REGISTRY_ACTION },
    });

    await expect(
      authorizeAndExecute(
        { toolName: 'admin_tool', rawInput: { note: 'x' }, surface: 'admin' },
        authContext({ userId: session.userId, isAdmin: true }),
      ),
    ).rejects.toThrow(ApiRouteError);

    // It reached check 7 and stopped there: the tool never ran.
    expect(trace).not.toContain('execute');
  });
});
