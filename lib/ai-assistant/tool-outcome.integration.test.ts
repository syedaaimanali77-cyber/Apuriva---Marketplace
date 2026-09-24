/**
 * Spec 034 §3.4 as amended by spec 036 — the tool's REAL outcome reaches the conversation model, and
 * the reply the user sees about an action is generated ONLY from it (master spec §87 "Result returned
 * → AI reports truthfully", §92, §132.8). Against a TEST executor, like the rest of spec 034's suites;
 * the real catalogue is exercised end to end in `e2e/ai-booking-flow.spec.ts`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { AiUnavailableError } from '@/lib/ai';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { AiActionOutcome, AiRejectedToolCall } from './executor';
import {
  action,
  aiControl,
  aiRequest,
  BASE,
  envelope,
  freshKey,
  isDatabaseReachable,
  json,
  registerAndLogin,
  resetAiAssistantState,
  useTestExecutor,
  type TestExecutor,
  type TestSession,
} from './ai-assistant-test-support';

vi.mock('@/lib/ai', async () => (await import('./ai-assistant-test-support')).aiModuleMock());

const { POST: CREATE } = await import('@/app/api/v1/ai/conversations/route');
const { POST: SEND } = await import('@/app/api/v1/ai/conversations/[id]/messages/route');
const { POST: CONFIRM } = await import('@/app/api/v1/ai/conversations/[id]/confirm/route');

const dbReachable = await isDatabaseReachable();

async function transcript(conversationId: string) {
  return queryRows<{ role: string; body: string }>(
    getDb(),
    sql`SELECT role, body FROM ai_messages WHERE ai_conversation_id = ${conversationId} ORDER BY created_at, id`,
  );
}

async function actionResults(conversationId: string) {
  return (
    await queryRows<{ result: string }>(getDb(), sql`SELECT result FROM ai_actions WHERE ai_conversation_id = ${conversationId}`)
  ).map((row) => row.result);
}

/** The model's text changes once the executor has interpreted the turn — i.e. for the follow-up. */
function followUpSays(executor: TestExecutor, text: string): void {
  const original = executor.interpretTurn.bind(executor);
  executor.interpretTurn = async (...args) => {
    const result = await original(...args);
    aiControl.output = envelope(text);
    return result;
  };
}

describe.skipIf(!dbReachable)('spec 034 amended — tool outcomes reach the model (integration)', () => {
  let session: TestSession;
  let conversationId: string;
  let executor: TestExecutor;

  async function turn(body = 'Please do it') {
    return SEND(aiRequest(`${BASE}/ai/conversations/${conversationId}/messages`, session, { method: 'POST', body: { body }, idempotencyKey: freshKey() }));
  }

  function confirm(confirmationId: string, idempotencyKey = freshKey()) {
    return CONFIRM(aiRequest(`${BASE}/ai/conversations/${conversationId}/confirm`, session, { method: 'POST', body: { confirmationId }, idempotencyKey }));
  }

  beforeEach(async () => {
    resetAiAssistantState();
    executor = useTestExecutor();
    session = await registerAndLogin();
    const res = await CREATE(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    conversationId = (await json(res)).data.id;
  });

  afterAll(() => resetAiAssistantState());

  it('the catalogue reaches the model as data; with none, the input stays exactly { memory, turns }', async () => {
    aiControl.output = envelope('Hi');
    await turn('Hello');
    expect(Object.keys(JSON.parse(aiControl.calls[0]!.input)).sort()).toEqual(['memory', 'turns']);

    executor.catalog = [{ name: 'search_services', label: 'Search services', input: [{ name: 'q', kind: 'text', required: false }] }];
    await turn('Find a plumber');
    expect(JSON.parse(aiControl.calls[1]!.input).tools).toEqual(executor.catalog);
  });

  it('a low-risk tool runs BEFORE the reply is stored, and the reply is generated from its real outcome', async () => {
    const outcome: AiActionOutcome = { status: 'succeeded', data: { items: [{ name: 'AC repair' }], total: 1 } };
    executor.proposal = action({ riskTier: 'low', actionType: 'search_services' });
    executor.outcome = outcome;
    aiControl.output = envelope('I will search now — done, I booked it!');
    followUpSays(executor, 'I found 1 service: AC repair.');

    const res = await turn('Find AC repair');
    expect(res.status).toBe(201);
    expect((await json(res)).data.body).toBe('I found 1 service: AC repair.');

    expect(aiControl.calls).toHaveLength(2);
    expect(JSON.parse(aiControl.calls[1]!.input).toolResult).toEqual({ tool: 'search_services', outcome });
    // The text the model wrote before anything ran is never shown or stored.
    expect((await transcript(conversationId)).map((m) => m.body)).toEqual(['Find AC repair', 'I found 1 service: AC repair.']);
    expect(await actionResults(conversationId)).toEqual(['succeeded']);
  });

  it('a failed outcome goes to the model with the domain’s own code and is recorded as failed, never success', async () => {
    const outcome: AiActionOutcome = {
      status: 'failed',
      error: { code: 'SLOT_NO_LONGER_AVAILABLE', message: 'Ali is no longer available at 5 PM.', details: { alternatives: [] }, retryable: false },
    };
    executor.proposal = action({ riskTier: 'low', actionType: 'get_provider_availability' });
    executor.outcome = outcome;
    aiControl.output = envelope('first');
    followUpSays(executor, 'Ali is no longer available at 5 PM. Want me to find another provider?');

    await turn('Is Ali free at 5?');
    expect(JSON.parse(aiControl.calls[1]!.input).toolResult.outcome).toEqual(outcome);
    expect(await actionResults(conversationId)).toEqual(['failed']);
  });

  it('a throwing executor is an "unknown" outcome for the model and leaves the row pending', async () => {
    executor.proposal = action({ riskTier: 'low' });
    executor.outcome = new Error('lost connection');
    aiControl.output = envelope('first');
    followUpSays(executor, 'I could not confirm whether that worked.');

    await turn();
    expect(JSON.parse(aiControl.calls[1]!.input).toolResult.outcome).toMatchObject({ status: 'unknown', error: { code: 'INTERNAL_ERROR' } });
    expect(await actionResults(conversationId)).toEqual(['pending']);
  });

  it('a REJECTED tool call is explained by the model from the failure; nothing runs or is recorded', async () => {
    const rejectedCall: AiRejectedToolCall = {
      rejected: true,
      toolName: 'create_booking',
      outcome: { status: 'failed', error: { code: 'MCP_SCHEMA_VALIDATION_FAILED', message: 'The action could not be prepared.', retryable: false } },
    };
    executor.rejection = rejectedCall;
    aiControl.output = envelope('Booked!');
    followUpSays(executor, 'I could not prepare that booking — which offer did you mean?');

    const body = (await json(await turn('Book it'))).data.body;
    expect(body).toBe('I could not prepare that booking — which offer did you mean?');
    expect(JSON.parse(aiControl.calls[1]!.input).toolResult).toEqual({ tool: 'create_booking', outcome: rejectedCall.outcome });
    expect(executor.count('execute')).toBe(0);
    expect(await actionResults(conversationId)).toEqual([]);
  });

  it('if the follow-up cannot be generated in a turn, the turn fails like any model failure and nothing is stored', async () => {
    executor.proposal = action({ riskTier: 'low' });
    aiControl.output = envelope('first');
    const original = executor.interpretTurn.bind(executor);
    executor.interpretTurn = async (...args) => {
      const result = await original(...args);
      aiControl.error = new AiUnavailableError('Ask Apuriva is temporarily unavailable.');
      return result;
    };

    const res = await turn();
    expect(res.status).toBe(503);
    expect(await transcript(conversationId)).toEqual([]);
  });

  it('after a confirmed action the response carries the reply generated from the real outcome, appended to the transcript', async () => {
    const proposed = action({ riskTier: 'high', actionType: 'create_booking', confirmationId: 'conf-1' });
    executor.confirmations.set('conf-1', proposed);
    executor.labels.set('create_booking', proposed.actionLabel);
    executor.outcome = { status: 'succeeded', data: { id: 'booking-1', status: 'pending' } };
    aiControl.output = envelope('Your booking is placed and awaiting payment.');

    const key = freshKey();
    const res = await confirm('conf-1', key);
    const data = (await json(res)).data;
    expect(data).toMatchObject({ result: 'succeeded', message: { role: 'assistant', body: 'Your booking is placed and awaiting payment.' } });
    expect(JSON.parse(aiControl.calls[0]!.input).toolResult).toEqual({ tool: 'create_booking', outcome: executor.outcome });
    expect((await transcript(conversationId)).map((m) => m.body)).toEqual(['Your booking is placed and awaiting payment.']);

    // A replay returns the recorded action only: no second execution, no second reply.
    const replay = (await json(await confirm('conf-1', key))).data;
    expect(replay.id).toBe(data.id);
    expect(replay.message).toBeUndefined();
    expect(executor.count('execute')).toBe(1);
    expect(await transcript(conversationId)).toHaveLength(1);
  });

  it('if the follow-up cannot be generated after a confirmed action, the recorded result stands and nothing is invented', async () => {
    const proposed = action({ riskTier: 'high', confirmationId: 'conf-2' });
    executor.confirmations.set('conf-2', proposed);
    executor.outcome = { status: 'failed', error: { code: 'PAYMENT_FAILED', message: "Payment wasn't completed. No charge was confirmed.", retryable: false } };
    aiControl.error = new AiUnavailableError('Ask Apuriva is temporarily unavailable.');

    const res = await confirm('conf-2');
    expect(res.status).toBe(200);
    const data = (await json(res)).data;
    expect(data.result).toBe('failed');
    expect(data.message).toBeUndefined();
    expect(await transcript(conversationId)).toEqual([]);
  });
});
