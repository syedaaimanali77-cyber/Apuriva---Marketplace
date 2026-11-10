import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { ApiRouteError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { mcpConfirmations } from '@/lib/db/schema';
import { queryRows } from '@/lib/offers/db';
import { authorizeAndExecute } from './authorize';
import {
  MCP_CONFIRMATION_TTL_MS,
  bindingMatches,
  createMcpConfirmation,
  readMcpConfirmation,
  resolveMcpConfirmation,
} from './confirmation';
import { MCP_CONFIRMATION_STALE } from './errors';
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

/** The parameters master spec §90 names — the shape a real booking confirmation binds. */
const PARAMETERS = [
  { label: 'Provider', value: 'Ali Raza' },
  { label: 'Service', value: 'AC repair' },
  { label: 'Date/time', value: '2026-10-01 17:00 PKT' },
  { label: 'Location', value: 'Gulberg, Lahore' },
  { label: 'Price', value: 'PKR 3,500.00' },
];

describe.skipIf(!dbReachable)('spec 035 confirmation record (integration)', () => {
  let session: TestSession;

  beforeEach(async () => {
    resetMcpTestState();
    session = await registerAndLogin();
  });
  afterEach(resetMcpTestState);

  it('AC-3: a binding stores the exact parameters, in order, with an expiry', async () => {
    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'high',
      parameters: PARAMETERS,
    });

    const stored = await readMcpConfirmation(record.id, session.userId);
    expect(stored!.parameters).toEqual(PARAMETERS);
    expect(stored!.toolName).toBe('book_service');
    expect(stored!.consumedAt).toBeNull();
    // Expiry is set from the moment it was issued, so it is ahead of now and within one TTL.
    const remaining = stored!.expiresAt.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(MCP_CONFIRMATION_TTL_MS);
  });

  it('AC-3: the same parameters resolve; a CHANGED value does not', async () => {
    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'high',
      parameters: PARAMETERS,
    });

    expect(
      (await resolveMcpConfirmation({ confirmationId: record.id, userId: session.userId, toolName: 'book_service', parameters: PARAMETERS }))
        .ok,
    ).toBe(true);

    const priceChanged = PARAMETERS.map((parameter) =>
      parameter.label === 'Price' ? { label: 'Price', value: 'PKR 4,200.00' } : parameter,
    );
    const resolution = await resolveMcpConfirmation({
      confirmationId: record.id,
      userId: session.userId,
      toolName: 'book_service',
      parameters: priceChanged,
    });
    expect(resolution).toEqual({ ok: false, rejection: 'parameters_changed' });
  });

  it('AC-3: an added or removed parameter also invalidates the binding', async () => {
    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'medium',
      parameters: PARAMETERS,
    });

    const added = [...PARAMETERS, { label: 'Currency', value: 'PKR' }];
    const removed = PARAMETERS.slice(0, PARAMETERS.length - 1);

    for (const parameters of [added, removed]) {
      expect(
        await resolveMcpConfirmation({ confirmationId: record.id, userId: session.userId, toolName: 'book_service', parameters }),
      ).toEqual({ ok: false, rejection: 'parameters_changed' });
    }
  });

  it('AC-3: order does not matter — the same agreement, listed differently, still binds', async () => {
    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'medium',
      parameters: PARAMETERS,
    });

    const reordered = [...PARAMETERS].reverse();
    expect(
      (await resolveMcpConfirmation({ confirmationId: record.id, userId: session.userId, toolName: 'book_service', parameters: reordered }))
        .ok,
    ).toBe(true);
  });

  it('AC-3: an expired binding is rejected', async () => {
    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'high',
      parameters: PARAMETERS,
    });

    const afterExpiry = new Date(Date.now() + MCP_CONFIRMATION_TTL_MS + 1000);
    expect(
      await resolveMcpConfirmation({
        confirmationId: record.id,
        userId: session.userId,
        toolName: 'book_service',
        parameters: PARAMETERS,
        now: afterExpiry,
      }),
    ).toEqual({ ok: false, rejection: 'expired' });
  });

  it('a binding belongs to one user and one tool: another user or tool never resolves it', async () => {
    const other = await registerAndLogin();
    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'high',
      parameters: PARAMETERS,
    });

    expect(await readMcpConfirmation(record.id, other.userId)).toBeNull();
    expect(
      await resolveMcpConfirmation({ confirmationId: record.id, userId: session.userId, toolName: 'cancel_booking', parameters: PARAMETERS }),
    ).toEqual({ ok: false, rejection: 'tool_mismatch' });
  });

  it('AC-1 check 6/AC-3: the pipeline executes with a matching binding and refuses a changed one', async () => {
    captureAudit();
    registerTestTool({ name: 'book_service', riskTier: 'high' });

    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'high',
      parameters: PARAMETERS,
    });
    const context = authContext({ userId: session.userId, confirmationId: record.id });

    const result = await authorizeAndExecute(
      { toolName: 'book_service', rawInput: { note: 'go ahead' }, parameters: PARAMETERS },
      context,
    );
    expect(result.success).toBe(true);
    expect(trace).toContain('execute');

    // A second attempt with the same binding is refused: one approval, one execution.
    const replay = await authorizeAndExecute(
      { toolName: 'book_service', rawInput: { note: 'again' }, parameters: PARAMETERS },
      context,
    ).catch((err: ApiRouteError) => err);
    expect((replay as ApiRouteError).code).toBe(MCP_CONFIRMATION_STALE);
    expect((replay as ApiRouteError).status).toBe(409);
  });

  it('AC-3: MCP_CONFIRMATION_STALE at 409 when a bound parameter changed before confirming', async () => {
    captureAudit();
    registerTestTool({ name: 'book_service', riskTier: 'high' });

    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'high',
      parameters: PARAMETERS,
    });

    const error = await authorizeAndExecute(
      {
        toolName: 'book_service',
        rawInput: { note: 'go ahead' },
        parameters: PARAMETERS.map((p) => (p.label === 'Date/time' ? { label: 'Date/time', value: '2026-10-02 09:00 PKT' } : p)),
      },
      authContext({ userId: session.userId, confirmationId: record.id }),
    ).catch((err: ApiRouteError) => err);

    expect((error as ApiRouteError).code).toBe(MCP_CONFIRMATION_STALE);
    expect(trace).not.toContain('execute');

    // Nothing was consumed: the user must be asked again, and that ask must still be possible.
    const [row] = await getDb()
      .select({ consumedAt: mcpConfirmations.consumedAt })
      .from(mcpConfirmations)
      .where(and(eq(mcpConfirmations.id, record.id), eq(mcpConfirmations.userId, session.userId)));
    expect(row!.consumedAt).toBeNull();
  });

  it('nothing in this spec writes ai_actions — that table stays spec 034s', async () => {
    captureAudit();
    registerTestTool({ name: 'book_service', riskTier: 'high' });
    const record = await createMcpConfirmation({
      userId: session.userId,
      toolName: 'book_service',
      riskTier: 'high',
      parameters: PARAMETERS,
    });

    const countActions = async () =>
      (await queryRows<{ count: number }>(getDb(), sql`SELECT count(*)::int AS count FROM ai_actions`))[0]!.count;

    const before = await countActions();
    await authorizeAndExecute(
      { toolName: 'book_service', rawInput: { note: 'go' }, parameters: PARAMETERS },
      authContext({ userId: session.userId, confirmationId: record.id }),
    );
    expect(await countActions()).toBe(before);
  });
});

describe('spec 035 binding comparison (no database)', () => {
  it('AC-3: compares label by label, value by value', () => {
    const record = {
      id: 'x',
      userId: 'u',
      toolName: 't',
      riskTier: 'high' as const,
      parameters: PARAMETERS,
      expiresAt: new Date(),
      consumedAt: null,
    };

    expect(bindingMatches(record, PARAMETERS)).toBe(true);
    expect(bindingMatches(record, [...PARAMETERS].reverse())).toBe(true);
    expect(bindingMatches(record, PARAMETERS.map((p) => ({ ...p, value: `${p.value} ` })))).toBe(false);
    expect(bindingMatches(record, PARAMETERS.slice(1))).toBe(false);
    expect(bindingMatches(record, [])).toBe(false);
  });
});
