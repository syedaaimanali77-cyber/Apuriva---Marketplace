/**
 * Spec 036 §6 "E2E (Vitest)".
 *
 * `e2e/*.spec.ts` is a configured VITEST pattern (vitest.config.ts `include`), not Playwright — there
 * is no browser runner in this repository and this spec adds none. What makes this end to end: a
 * whole journey, in order, through the REAL route handlers, spec 034's orchestration, spec 036's REAL
 * catalogue and executor, spec 035's REAL pipeline and spec 020's REAL `createBooking`, on the
 * `*_test` database. Only the model's text is scripted.
 *
 * Journey: the assistant looks the request up (a read tool whose real result reaches the model), then
 * proposes a booking; the user confirms through the structured card; exactly one booking exists —
 * including across a retried confirmation (master spec §115's critical example).
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiControl, aiRequest, BASE, envelope, freshKey, json, resetAiAssistantState } from '@/lib/ai-assistant/ai-assistant-test-support';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { seedBookingScenario } from '@/lib/bookings/bookings-test-support';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import {
  countBookingsForOffer,
  isDatabaseReachable,
  resetToolCatalog,
  toolCallOutput,
  useToolCatalog,
} from '@/lib/mcp-tools/mcp-tools-test-support';

vi.mock('@/lib/ai', async () => (await import('@/lib/ai-assistant/ai-assistant-test-support')).aiModuleMock());

const conversations = await import('@/app/api/v1/ai/conversations/route');
const messages = await import('@/app/api/v1/ai/conversations/[id]/messages/route');
const confirm = await import('@/app/api/v1/ai/conversations/[id]/confirm/route');
const activity = await import('@/app/api/v1/ai/activity/route');

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('the assistant books a service through its tools, end to end (spec 036)', { timeout: 120_000 }, () => {
  beforeEach(async () => {
    resetAiAssistantState();
    resetRateLimitState();
    await useToolCatalog();
  });

  afterEach(() => {
    resetToolCatalog();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  afterAll(() => resetAiAssistantState());

  it('read, propose, confirm, retry — exactly one booking, and every reply comes from a real result', async () => {
    const scenario = await seedBookingScenario();
    const session = scenario.customer;
    resetRateLimitState();

    const created = await conversations.POST(aiRequest(`${BASE}/ai/conversations`, session, { method: 'POST', body: {}, idempotencyKey: freshKey() }));
    const id = (await json(created)).data.id as string;
    const turn = (body: string) =>
      messages.POST(aiRequest(`${BASE}/ai/conversations/${id}/messages`, session, { method: 'POST', body: { body }, idempotencyKey: freshKey() }));

    // 1. A READ tool: the model is shown the catalogue, asks for the request, and is then given the
    //    request's REAL data before its reply is stored.
    aiControl.output = toolCallOutput('get_request', { requestId: scenario.requestId }, 'Let me look.');
    const read = await turn('What is the status of my request?');
    expect(read.status).toBe(201);
    const firstInput = JSON.parse(aiControl.calls[0]!.input);
    expect(firstInput.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['get_request', 'create_booking']));
    expect(firstInput.tools.map((tool: { name: string }) => tool.name)).not.toContain('get_provider_earnings');
    const followUp = JSON.parse(aiControl.calls[1]!.input);
    expect(followUp.toolResult).toMatchObject({ tool: 'get_request', outcome: { status: 'succeeded', data: { id: scenario.requestId } } });

    // 2. A HIGH-risk tool is only PROPOSED: a structured §90 card, nothing executed.
    aiControl.output = toolCallOutput('create_booking', { offerId: scenario.offerId }, 'Shall I book this for you?');
    const proposal = (await json(await turn('Book the accepted offer'))).data;
    expect(proposal.body).toBe('Shall I book this for you?');
    expect(proposal.pendingConfirmation).toMatchObject({ riskTier: 'high', actionLabel: 'Book a service' });
    expect(proposal.pendingConfirmation.parameters.map((p: { label: string }) => p.label)).toEqual(expect.arrayContaining(['Service', 'Price']));
    expect(JSON.stringify(proposal.pendingConfirmation)).not.toContain(scenario.offerId);
    expect(await countBookingsForOffer(scenario.offerId)).toBe(0);

    // 3. The explicit confirmation runs it with the SERVER-stored input; the reply is written from
    //    the real outcome.
    aiControl.output = envelope('Your booking is placed and awaiting payment.');
    const key = freshKey();
    const confirmRequest = () =>
      confirm.POST(
        aiRequest(`${BASE}/ai/conversations/${id}/confirm`, session, {
          method: 'POST',
          body: { confirmationId: proposal.pendingConfirmation.confirmationId },
          idempotencyKey: key,
        }),
      );
    const confirmed = await confirmRequest();
    expect(confirmed.status).toBe(200);
    const result = (await json(confirmed)).data;
    expect(result).toMatchObject({ result: 'succeeded', message: { role: 'assistant', body: 'Your booking is placed and awaiting payment.' } });
    const lastInput = JSON.parse(aiControl.calls.at(-1)!.input);
    expect(lastInput.toolResult).toMatchObject({ tool: 'create_booking', outcome: { status: 'succeeded', data: { offerId: scenario.offerId } } });
    expect(await countBookingsForOffer(scenario.offerId)).toBe(1);

    // 4. A simulated client retry of the same confirmation replays; it never books twice.
    const retried = await confirmRequest();
    expect(retried.status).toBe(200);
    expect((await json(retried)).data.id).toBe(result.id);
    // A second, fresh attempt at the same (already used) confirmation is refused as stale.
    const again = await confirm.POST(
      aiRequest(`${BASE}/ai/conversations/${id}/confirm`, session, {
        method: 'POST',
        body: { confirmationId: proposal.pendingConfirmation.confirmationId },
        idempotencyKey: freshKey(),
      }),
    );
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe('MCP_CONFIRMATION_STALE');
    expect(await countBookingsForOffer(scenario.offerId)).toBe(1);

    // 5. Activity history shows both actions with their confirmed results; one keyed tool call per booking.
    const entries = (await json(await activity.GET(aiRequest(`${BASE}/ai/activity`, session)))).data;
    expect(entries.map((e: { actionLabel: string; result: string }) => [e.actionLabel, e.result])).toEqual([
      ['Book a service', 'succeeded'],
      ['Look up a request', 'succeeded'],
    ]);
    const calls = await queryRows<{ idempotency_key: string | null; action_type: string }>(
      getDb(),
      sql`SELECT t.idempotency_key, a.action_type FROM ai_tool_calls t JOIN ai_actions a ON a.id = t.ai_action_id
           WHERE a.ai_conversation_id = ${id} ORDER BY t.created_at`,
    );
    expect(calls.map((c) => c.action_type)).toEqual(['get_request', 'create_booking']);
    expect(calls[0]!.idempotency_key).toBeNull();
    expect(calls[1]!.idempotency_key).not.toBeNull();
  });
});
