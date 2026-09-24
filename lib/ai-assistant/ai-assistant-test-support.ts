/**
 * Spec 034 §6 fixtures.
 *
 * Every behaviour is driven through the REAL route handlers with real sessions against the isolated
 * `*_test` database. Only two things are controlled:
 *
 * - The model's OUTPUT, where a test needs a structured reply envelope the sandbox adapter never
 *   produces. The test file mocks `@/lib/ai`'s `completeAi` (the `lib/support/ai-assist.test.ts`
 *   pattern) and sets `aiOutput` here; `null` falls through to the real spec 033 path.
 * - The `AiActionExecutor` port. Specs 035/036 are unbuilt, so every action-tier behaviour runs
 *   against `TestExecutor` below, exactly as §6 prescribes. Its real authorization is spec 035's to test.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { IDEMPOTENCY_KEY_HEADER } from '@/lib/api/idempotency';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import {
  registerAiActionExecutor,
  resetAiActionExecutor,
  type AiActionExecutor,
  type AiActionOutcome,
  type AiModelTool,
  type AiProposedAction,
  type AiRejectedToolCall,
} from './executor';

export { isDatabaseReachable } from '@/lib/db/test-support';
export { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';

export const BASE = 'http://localhost/api/v1';

export function freshKey(prefix = 'ai'): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * A request carrying the session cookie and CSRF header. `idempotencyKey: null` omits the header
 * (for routes that take none, and to prove a required one is enforced).
 */
export function aiRequest(
  url: string,
  session: { sessionId: string; csrfToken: string } | null,
  init?: { method?: string; body?: unknown; idempotencyKey?: string | null; csrf?: boolean },
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${session.sessionId}`;
    if (init?.csrf !== false) headers[CSRF_HEADER_NAME] = session.csrfToken;
  }
  const method = init?.method ?? 'GET';
  if (init?.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = init.idempotencyKey;
  return new Request(url, {
    method,
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export async function json(response: Response): Promise<Record<string, any>> {
  return response.status === 204 ? {} : ((await response.json()) as Record<string, any>);
}

/**
 * The controllable model call (see the file header). `error` is thrown as-is (e.g. a spec 033
 * degradable error); otherwise `output` is returned; with both `null`, the real spec 033 path runs.
 */
export const aiControl: { output: string | null; error: Error | null; calls: Array<{ task: string; input: string }> } = {
  output: null,
  error: null,
  calls: [],
};

/**
 * The `@/lib/ai` module a test file mocks in, keeping everything real except `completeAi`:
 *   vi.mock('@/lib/ai', async () => (await import('./ai-assistant-test-support')).aiModuleMock());
 */
export async function aiModuleMock(): Promise<typeof import('@/lib/ai')> {
  const { vi } = await import('vitest');
  const actual = await vi.importActual<typeof import('@/lib/ai')>('@/lib/ai');
  return {
    ...actual,
    completeAi: async (request: Parameters<typeof actual.completeAi>[0]) => {
      aiControl.calls.push({ task: request.task, input: request.input });
      if (aiControl.error) throw aiControl.error;
      if (aiControl.output !== null) return { output: aiControl.output, tokensUsed: 1, cached: false };
      return actual.completeAi(request);
    },
  };
}

export function envelope(reply: string, memoryProposal?: { key: string; value: unknown }): string {
  return JSON.stringify(memoryProposal ? { reply, memoryProposal } : { reply });
}

/** A test double for the specs 035/036 executor, recording every call it receives. */
export class TestExecutor implements AiActionExecutor {
  proposal: AiProposedAction | null = null;
  confirmations = new Map<string, AiProposedAction>();
  /** Spec 036 amendment: the port returns the real outcome, not a bare boolean. */
  outcome: AiActionOutcome | Error = { status: 'succeeded', data: null };
  /** What `catalogFor` offers the model; empty keeps the input `{ memory, turns }` as before. */
  catalog: AiModelTool[] = [];
  staleError: Error | null = null;
  labels = new Map<string, string>();
  calls: Array<{ method: string; args: unknown[] }> = [];

  /** Spec 036 amendment: a tool call the executor refuses to propose, fed back to the model. */
  rejection: AiRejectedToolCall | null = null;

  async interpretTurn(...args: Parameters<AiActionExecutor['interpretTurn']>): Promise<AiProposedAction | AiRejectedToolCall | null> {
    this.calls.push({ method: 'interpretTurn', args });
    return this.rejection ?? this.proposal;
  }

  async resolveConfirmation(...args: Parameters<AiActionExecutor['resolveConfirmation']>) {
    this.calls.push({ method: 'resolveConfirmation', args });
    if (this.staleError) throw this.staleError;
    return this.confirmations.get(args[1]) ?? null;
  }

  async execute(...args: Parameters<AiActionExecutor['execute']>) {
    this.calls.push({ method: 'execute', args });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }

  labelFor(actionType: string) {
    return this.labels.get(actionType) ?? null;
  }

  async catalogFor(...args: Parameters<AiActionExecutor['catalogFor']>) {
    this.calls.push({ method: 'catalogFor', args });
    return this.catalog;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

export function useTestExecutor(): TestExecutor {
  const executor = new TestExecutor();
  registerAiActionExecutor(executor);
  return executor;
}

/** Per test file: inert executor, controllable output cleared, limiter reset. */
export function resetAiAssistantState(): void {
  resetAiActionExecutor();
  aiControl.output = null;
  aiControl.error = null;
  aiControl.calls = [];
  resetRateLimitState();
}

export function action(overrides: Partial<AiProposedAction> = {}): AiProposedAction {
  return {
    actionType: 'test_tool',
    actionLabel: 'Book AC repair with Ali Raza',
    riskTier: 'low',
    parameters: [
      { label: 'Service', value: 'AC repair' },
      { label: 'Price', value: 'PKR 3,200' },
    ],
    related: null,
    ...overrides,
  };
}

/** Every row this spec could have written for a user — the "nothing persisted" assertion. */
export async function aiRowCounts(userId: string): Promise<{ conversations: number; messages: number; memories: number; actions: number }> {
  const [row] = await queryRows<{ conversations: number; messages: number; memories: number; actions: number }>(
    getDb(),
    sql`SELECT
          (SELECT count(*)::int FROM ai_conversations WHERE user_id = ${userId}) AS conversations,
          (SELECT count(*)::int FROM ai_messages m JOIN ai_conversations c ON c.id = m.ai_conversation_id WHERE c.user_id = ${userId}) AS messages,
          (SELECT count(*)::int FROM ai_memories WHERE user_id = ${userId}) AS memories,
          (SELECT count(*)::int FROM ai_actions a JOIN ai_conversations c ON c.id = a.ai_conversation_id WHERE c.user_id = ${userId}) AS actions`,
  );
  return row!;
}

/** A published category to name in a `preferred_category` memory entry. */
export async function seedPublishedCategory(status: 'published' | 'draft' = 'published'): Promise<{ id: string; name: string }> {
  const name = `Category ${randomUUID().slice(0, 8)}`;
  const [row] = await queryRows<{ id: string; name: string }>(
    getDb(),
    sql`INSERT INTO categories (name, slug, status) VALUES (${name}, ${`cat-${randomUUID()}`}, ${status}) RETURNING id, name`,
  );
  return row!;
}

/**
 * Seeds one conversation with a two-message transcript, one memory entry and one activity entry for
 * `userId`, directly at the database layer — for spec 008's privacy suites, which test the export
 * and sweep functions rather than the routes that produce this data.
 */
export async function seedAiAssistantData(userId: string): Promise<{ conversationId: string; actionId: string }> {
  const db = getDb();
  const [conversation] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO ai_conversations (user_id, idempotency_key, idempotency_fingerprint)
        VALUES (${userId}, ${randomUUID()}, 'seed') RETURNING id`,
  );
  const conversationId = conversation!.id;
  await db.execute(sql`
    INSERT INTO ai_messages (ai_conversation_id, role, body, created_at)
    VALUES (${conversationId}, 'user', 'Find me an electrician in DHA', clock_timestamp())
  `);
  await db.execute(sql`
    INSERT INTO ai_messages (ai_conversation_id, role, body, idempotency_key, idempotency_fingerprint, created_at)
    VALUES (${conversationId}, 'assistant', 'Here are three options.', ${randomUUID()}, 'seed', clock_timestamp() + interval '1 microsecond')
  `);
  await db.execute(sql`
    INSERT INTO ai_memories (user_id, key, value) VALUES (${userId}, 'preferred_area', '{"city":"Lahore","area":"DHA"}'::jsonb)
  `);
  const [actionRow] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO ai_actions (ai_conversation_id, action_type, risk_tier, required_confirmation, result)
        VALUES (${conversationId}, 'search_providers', 'low', false, 'succeeded') RETURNING id`,
  );
  return { conversationId, actionId: actionRow!.id };
}
