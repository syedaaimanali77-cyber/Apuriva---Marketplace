/**
 * Spec 032 §6 "AI boundary and degradation" (AC-1).
 *
 * AC-1's promise is absolute: in EVERY AI outcome the user can still reach a human. So these
 * enumerate the failure modes spec 033 can produce and assert the same answer each time — `null`,
 * no throw, nothing stored.
 *
 * `lib/support/ai-boundary.test.ts` proves the AI cannot reach a decision; this proves it cannot
 * block one either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiProviderConfigurationError,
  AiQuotaExceededError,
  AiRateLimitedError,
  AiUnavailableError,
} from '@/lib/ai/errors';

const completeAi = vi.fn();
const isAiAssistantEnabled = vi.fn(() => true);

vi.mock('@/lib/ai', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai')>('@/lib/ai');
  return {
    ...actual,
    completeAi: (...args: unknown[]) => completeAi(...args),
    isAiAssistantEnabled: () => isAiAssistantEnabled(),
  };
});

const { answerCommonQuestion, summarizeForTriage } = await import('./ai-assist');

const SUMMARY_INPUT = {
  subject: 'Double charge',
  description: 'I was charged twice for the same booking.',
  category: 'payment',
};

afterEach(() => {
  vi.clearAllMocks();
  isAiAssistantEnabled.mockReturnValue(true);
});

describe('answerCommonQuestion (AC-1)', () => {
  it('returns the answer when the assistant works', async () => {
    completeAi.mockResolvedValue({ output: '  You can cancel from the booking page.  ', tokensUsed: 20, cached: false });
    await expect(answerCommonQuestion('How do I cancel?', 'user-1')).resolves.toBe(
      'You can cancel from the booking page.',
    );
  });

  it('attributes the call to the USER, whose quota it is', async () => {
    completeAi.mockResolvedValue({ output: 'ok', tokensUsed: 1, cached: false });
    await answerCommonQuestion('How do I cancel?', 'user-1');
    expect(completeAi).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'conversation', subject: { kind: 'user', userId: 'user-1' } }),
    );
  });

  it('returns null WITHOUT calling the provider when the assistant is switched off', async () => {
    isAiAssistantEnabled.mockReturnValue(false);
    await expect(answerCommonQuestion('How do I cancel?', 'user-1')).resolves.toBeNull();
    // A disabled assistant must cost nothing and consume no quota.
    expect(completeAi).not.toHaveBeenCalled();
  });

  it('degrades to null on EVERY spec 033 failure mode', async () => {
    const failures: unknown[] = [
      new AiRateLimitedError(30),
      new AiQuotaExceededError(),
      new AiUnavailableError(),
      new AiProviderConfigurationError('no key configured'),
      new Error('something unexpected'),
      'a thrown string',
    ];

    for (const failure of failures) {
      completeAi.mockRejectedValueOnce(failure);
      // Never throws — a rate limit or an exhausted quota must not surface as an error from a
      // support route, because the user has exceeded no support limit.
      await expect(answerCommonQuestion('How do I cancel?', 'user-1')).resolves.toBeNull();
    }
  });

  it('treats an empty answer as no answer', async () => {
    completeAi.mockResolvedValue({ output: '   ', tokensUsed: 0, cached: false });
    await expect(answerCommonQuestion('How do I cancel?', 'user-1')).resolves.toBeNull();
  });

  it('bounds the prompt so a long question cannot drive an unbounded call', async () => {
    completeAi.mockResolvedValue({ output: 'ok', tokensUsed: 1, cached: false });
    await answerCommonQuestion('x'.repeat(50_000), 'user-1');
    const input = completeAi.mock.calls[0]![0].input as string;
    expect(input.length).toBeLessThanOrEqual(4000);
  });
});

describe('summarizeForTriage (AC-5, advisory only)', () => {
  it('attributes the call to the SYSTEM, so no participant quota is spent', async () => {
    completeAi.mockResolvedValue({ output: 'Customer reports a double charge.', tokensUsed: 30, cached: false });
    await summarizeForTriage(SUMMARY_INPUT);
    expect(completeAi).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'summarization',
        subject: { kind: 'system', label: 'support_triage_summary' },
      }),
    );
  });

  it('degrades to null on every failure, silently', async () => {
    for (const failure of [new AiUnavailableError(), new AiQuotaExceededError(), new Error('boom')]) {
      completeAi.mockRejectedValueOnce(failure);
      await expect(summarizeForTriage(SUMMARY_INPUT)).resolves.toBeNull();
    }
  });

  it('returns null when the assistant is off, without calling the provider', async () => {
    isAiAssistantEnabled.mockReturnValue(false);
    await expect(summarizeForTriage(SUMMARY_INPUT)).resolves.toBeNull();
    expect(completeAi).not.toHaveBeenCalled();
  });

  it('never sends a ticket id or any identifier in the prompt', async () => {
    completeAi.mockResolvedValue({ output: 'summary', tokensUsed: 5, cached: false });
    await summarizeForTriage(SUMMARY_INPUT);
    const input = completeAi.mock.calls[0]![0].input as string;
    expect(input).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
