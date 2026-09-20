/**
 * Spec 031 §6 "AI boundary" — AC-6, master §132.17 and §2097.
 *
 * THE CLAIM UNDER TEST IS STRUCTURAL, NOT BEHAVIOURAL: it is not "the AI currently does not decide
 * anything", it is "there is no interface through which it could". So this reads the source and
 * checks the shape of the seam — the same device spec 030 uses.
 *
 * `ai-assist.ts` takes strings and returns `string | null`. It has no database handle, no
 * transaction, no status argument and no amount argument. The decision functions take no
 * AI-derived parameter. Together those two facts mean an AI verdict cannot reach an outcome even
 * by mistake.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const DIR = __dirname;

function code(file: string): string {
  return readFileSync(join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('AI is advisory only (spec 031 AC-6, DECIDED-8)', () => {
  it('ai-assist.ts has no database access and no transaction', () => {
    const source = code('ai-assist.ts');
    expect(source).not.toMatch(/getDb\(|queryRows|db\.transaction|from 'drizzle-orm'/);
  });

  it('ai-assist.ts returns only a string or null — never a decision, status, amount or outcome', () => {
    const source = code('ai-assist.ts');
    expect(source).toMatch(/Promise<string \| null>/);
    expect(source).not.toMatch(/DisputeDecision|DisputeStatus|DisputeAppealOutcome|MinorUnits/);
  });

  it('no decision function accepts an AI-derived parameter', () => {
    // If any of these imported the summarizer's OUTPUT as an input, an AI verdict would have a
    // path into an outcome. They may call it (resolve.ts refreshes the advisory summary after
    // commit), but none may take one as an argument.
    for (const file of ['resolve.ts', 'appeal.ts', 'close.ts']) {
      const source = code(file);
      expect(source).not.toMatch(/aiSummary\s*:\s*string/);
      expect(source).not.toMatch(/summary\s*:\s*string\s*\)/);
      expect(source).not.toMatch(/function\s+\w+\([^)]*\baiSummary\b/);
    }
  });

  it('the advisory column is written only as a side effect, never read by a decision path', () => {
    for (const file of ['resolve.ts', 'appeal.ts', 'close.ts', 'gate.ts', 'transitions.ts']) {
      const source = code(file);
      // No decision path may SELECT it.
      expect(source).not.toMatch(/SELECT[\s\S]{0,200}?ai_summary/i);
    }
    // Only the admin read surface exposes it at all.
    expect(code('rows.ts')).toMatch(/ai_summary/);
  });

  it('the participant DTO has no field an AI summary could occupy', () => {
    const types = readFileSync(join(DIR, '..', 'types', 'disputes.ts'), 'utf8');
    const participant = types.slice(types.indexOf('export interface DisputeDto'), types.indexOf('export interface DisputeSummaryDto'));
    expect(participant).not.toMatch(/aiSummary/);

    const admin = types.slice(types.indexOf('export interface AdminDisputeDto'));
    expect(admin).toMatch(/aiSummary/);
  });

  it('uses the existing summarization task, so no spec 033 migration is required', () => {
    expect(code('ai-assist.ts')).toMatch(/task:\s*'summarization'/);
  });

  it('bills the platform, not the participant whose quota it would otherwise consume', () => {
    expect(code('ai-assist.ts')).toMatch(/kind:\s*'system'/);
  });
});

describe('AI degradation is total and silent (spec 031 AC-6)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns null when the assistant throws for any reason', async () => {
    vi.resetModules();
    vi.doMock('@/lib/ai', () => ({
      completeAi: vi.fn().mockRejectedValue(new Error('provider outage')),
      isAiDegradable: () => true,
    }));
    const { summarizeForTriage } = await import('./ai-assist');
    await expect(summarizeForTriage({ reason: 'The provider never arrived.' })).resolves.toBeNull();
  });

  it('returns null — and logs — for a non-degradable failure, rather than propagating it', async () => {
    vi.resetModules();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@/lib/ai', () => ({
      completeAi: vi.fn().mockRejectedValue(new TypeError('a programming error')),
      isAiDegradable: () => false,
    }));
    const { summarizeForTriage } = await import('./ai-assist');

    await expect(summarizeForTriage({ reason: 'The provider never arrived.' })).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('returns null for an empty completion rather than storing a blank suggestion', async () => {
    vi.resetModules();
    vi.doMock('@/lib/ai', () => ({
      completeAi: vi.fn().mockResolvedValue({ output: '   ' }),
      isAiDegradable: () => true,
    }));
    const { summarizeForTriage } = await import('./ai-assist');
    await expect(summarizeForTriage({ reason: 'The provider never arrived.' })).resolves.toBeNull();
  });

  it('bounds the prompt, so a long dispute cannot drive an unbounded call', async () => {
    vi.resetModules();
    const completeAi = vi.fn().mockResolvedValue({ output: 'summary' });
    vi.doMock('@/lib/ai', () => ({ completeAi, isAiDegradable: () => true }));
    const { summarizeForTriage } = await import('./ai-assist');

    await summarizeForTriage({
      reason: 'x'.repeat(10_000),
      messages: Array.from({ length: 500 }, () => 'y'.repeat(200)),
    });

    const input = completeAi.mock.calls[0]![0].input as string;
    expect(input.length).toBeLessThanOrEqual(4000);
  });

  it('passes evidence DESCRIPTORS only — never bytes and never a signed URL', async () => {
    vi.resetModules();
    const completeAi = vi.fn().mockResolvedValue({ output: 'summary' });
    vi.doMock('@/lib/ai', () => ({ completeAi, isAiDegradable: () => true }));
    const { summarizeForTriage } = await import('./ai-assist');

    await summarizeForTriage({ reason: 'A dispute reason.', evidence: ['image: doorstep.jpg'] });

    const input = completeAi.mock.calls[0]![0].input as string;
    expect(input).toContain('doorstep.jpg');
    expect(input).not.toMatch(/https?:\/\//);
  });
});
