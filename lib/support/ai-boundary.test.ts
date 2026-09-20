/**
 * Spec 032 §6 "AI boundary" (AC-1, DECIDED-2) — asserted at SOURCE LEVEL.
 *
 * Spec 031's `lib/disputes/ai-boundary.test.ts`, applied to support. The claim being defended is
 * not "the AI currently does not classify tickets" but "there is no interface through which it
 * could" — so these read the source rather than exercising behaviour.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SUPPORT_DIR = join(__dirname);
const AI_MODULE = 'ai-assist.ts';

function read(name: string): string {
  return readFileSync(join(SUPPORT_DIR, name), 'utf8');
}

function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function decisionModules(): { name: string; body: string }[] {
  return ['create.ts', 'assign.ts', 'triage.ts', 'resolve.ts', 'handoff.ts', 'lifecycle.ts', 'messages.ts'].map(
    (name) => ({ name, body: code(read(name)) }),
  );
}

describe('the AI module cannot reach a decision', () => {
  const ai = code(read(AI_MODULE));

  it('has no database access, no transaction and no SQL', () => {
    expect(ai).not.toContain('getDb');
    expect(ai).not.toContain('queryRows');
    expect(ai).not.toMatch(/\bsql`/);
    expect(ai).not.toContain('transaction');
  });

  it('imports nothing from the platform but spec 033 own entry point', () => {
    const imports = ai.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line, `unexpected import: ${line}`).toContain("@/lib/ai");
    }
  });

  it('takes and returns only strings — no ticket id, no status, no category', () => {
    // Both exported functions resolve to `string | null`, so nothing structured can come back.
    expect(ai).toMatch(/Promise<string \| null>/);
    for (const forbidden of ['SupportTicketStatus', 'SupportPriority', 'SupportResolutionKind', 'ticketId']) {
      expect(ai, `must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('uses only AI tasks that already exist in spec 033 vocabulary', () => {
    const tasks = [...ai.matchAll(/task:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(['conversation', 'summarization']).toContain(task);
  });

  it('attributes the triage summary to the system, never to a participant quota', () => {
    expect(ai).toContain("kind: 'system'");
    expect(ai).toContain('support_triage_summary');
  });

  it('degrades on every failure rather than propagating one', () => {
    expect(ai).toContain('isAiDegradable');
    // Every catch returns null; no `throw` escapes the module.
    expect(ai).not.toMatch(/\bthrow\b/);
  });
});

describe('no decision path accepts AI-derived input', () => {
  it('no mutating module imports the AI module except create.ts for the advisory summary', () => {
    for (const { name, body } of decisionModules()) {
      if (name === 'create.ts') continue;
      expect(body, `${name} must not import ai-assist`).not.toContain('ai-assist');
      expect(body, `${name} must not call completeAi`).not.toContain('completeAi');
    }
  });

  it('create.ts uses the summary ONLY to fill ai_summary, never to set a field that matters', () => {
    const body = code(read('create.ts'));
    expect(body).toContain('summarizeForTriage');
    // The single write it feeds.
    expect(body).toMatch(/SET ai_summary/);
    // And the priority it stores comes from the category table, not from anything AI produced.
    expect(body).toContain('priorityForCategory');
    expect(body).not.toMatch(/priority\s*=\s*summary/);
    expect(body).not.toMatch(/category\s*=\s*summary/);
  });

  it('no module reads ai_summary back to branch on it', () => {
    for (const { name, body } of decisionModules()) {
      expect(body, `${name} must not branch on ai_summary`).not.toMatch(/if\s*\(.*ai_?[Ss]ummary/);
    }
  });

  it('the resolve path takes a human reason and nothing machine-generated', () => {
    const body = code(read('resolve.ts'));
    expect(body).toContain('ParsedResolve');
    expect(body).not.toContain('completeAi');
    expect(body).not.toContain('aiSummary');
  });
});
