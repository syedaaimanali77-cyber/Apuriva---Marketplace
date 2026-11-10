/**
 * Spec 030 §6 (AC-4) — the AI assistance is advisory and cannot reach a decision.
 *
 * The strongest guarantee is structural and lives in `boundary.test.ts` (no database access, no
 * provider import). What this file adds is the behavioural half: EVERY failure mode degrades to
 * `null` rather than propagating, so an AI outage can never block a safety submission.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeForTriage } from './ai-assist';

vi.mock('@/lib/ai', () => ({
  completeAi: vi.fn(),
  isAiDegradable: (err: unknown) => err instanceof Error && err.name === 'AiUnavailableError',
}));

const { completeAi } = await import('@/lib/ai');
const mocked = vi.mocked(completeAi);

afterEach(() => {
  vi.clearAllMocks();
});

describe('spec 030 AI triage assistance (AC-4)', () => {
  it('returns the summary when the assistant answers', async () => {
    mocked.mockResolvedValue({ output: '  A dispute about noise.  ', tokensUsed: 10, cached: false });
    expect(await summarizeForTriage('They played music all night.')).toBe('A dispute about noise.');
  });

  it('uses the EXISTING summarization task, so no spec 033 migration is needed', async () => {
    mocked.mockResolvedValue({ output: 'x', tokensUsed: 1, cached: false });
    await summarizeForTriage('A description.');
    expect(mocked.mock.calls[0]![0]).toMatchObject({ task: 'summarization' });
  });

  it('attributes the call to the SYSTEM, not the reporter, so it cannot consume their quota', async () => {
    mocked.mockResolvedValue({ output: 'x', tokensUsed: 1, cached: false });
    await summarizeForTriage('A description.');
    expect(mocked.mock.calls[0]![0].subject).toEqual({ kind: 'system', label: 'safety_triage_summary' });
  });

  it('bounds the prompt, so a long report cannot drive an unbounded call', async () => {
    mocked.mockResolvedValue({ output: 'x', tokensUsed: 1, cached: false });
    await summarizeForTriage('a'.repeat(50_000));
    expect(mocked.mock.calls[0]![0].input.length).toBeLessThanOrEqual(2000);
  });

  describe('degradation is total and silent', () => {
    it('returns null when the assistant is unavailable', async () => {
      const err = new Error('down');
      err.name = 'AiUnavailableError';
      mocked.mockRejectedValue(err);
      expect(await summarizeForTriage('A description.')).toBeNull();
    });

    it('returns null for an UNEXPECTED error too — no failure may affect a safety report', async () => {
      mocked.mockRejectedValue(new TypeError('something nobody predicted'));
      expect(await summarizeForTriage('A description.')).toBeNull();
    });

    it('returns null for an empty answer rather than storing a blank suggestion', async () => {
      mocked.mockResolvedValue({ output: '   ', tokensUsed: 1, cached: false });
      expect(await summarizeForTriage('A description.')).toBeNull();
    });
  });

  it('returns a string or null and nothing else — it cannot express a decision', async () => {
    mocked.mockResolvedValue({ output: 'A summary.', tokensUsed: 1, cached: false });
    const result = await summarizeForTriage('A description.');
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});
