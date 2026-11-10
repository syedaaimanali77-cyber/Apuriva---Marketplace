/**
 * Spec 034 §3.1, §3.4, §3.9 – §3.11 — the module boundaries, checked statically:
 *
 *   - `lib/ai-assistant` reaches AI only through the `@/lib/ai` barrel (spec 033 owns `lib/ai`);
 *   - `lib/ai` never persists or even names a transcript table — transcripts live here, not there;
 *   - no transactional module imports `lib/ai-assistant` (the assistant sits above them, never inside);
 *   - `ai_memories` is WRITTEN (insert/update) only by the confirmed-memory path in `memory.ts`;
 *   - the temporary-turn and suggestion paths contain no database write and no executor call;
 *   - no provider-characteristics or communication-preferences memory key exists anywhere.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const HERE = __dirname;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry) && !entry.includes('test-support')) {
      files.push(full);
    }
  }
  return files;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join('/');
const read = (file: string) => readFileSync(file, 'utf8');
/** Executable code only: these modules describe at length, in comments, what they never do. */
const code = (source: string) =>
  source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\*\*|\*|\/\/|--)/.test(line))
    .join('\n');

/** The source of one exported function, up to the next top-level export. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('spec 034 module boundaries', () => {
  it('lib/ai-assistant reaches AI only through the @/lib/ai barrel', () => {
    const offenders = walk(HERE).filter((file) => /from\s+['"]@\/lib\/ai\/[^'"]+['"]/.test(read(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('lib/ai never imports lib/ai-assistant and never names a transcript or memory table', () => {
    const offenders = walk(join(ROOT, 'lib', 'ai')).filter((file) =>
      /lib\/ai-assistant|ai_messages|ai_memories|aiMessages|aiMemories/.test(read(file)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('no transactional module imports lib/ai-assistant', () => {
    const transactional = ['requests', 'offers', 'bookings', 'payments', 'refunds', 'cancellation', 'payouts', 'messaging', 'disputes', 'reviews', 'safety', 'support'];
    const offenders = transactional
      .flatMap((dir) => walk(join(ROOT, 'lib', dir)))
      .filter((file) => /@\/lib\/ai-assistant/.test(read(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('ai_memories is written only by the confirmed-memory path', () => {
    const writers = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))].filter((file) =>
      /INSERT INTO ai_memories|UPDATE ai_memories|insert\(aiMemories\)|update\(aiMemories\)/.test(read(file)),
    );
    expect(writers.map(rel)).toEqual(['lib/ai-assistant/memory.ts']);
    // …and inside it, only `confirmMemory` does so.
    const source = read(join(HERE, 'memory.ts'));
    expect(functionBody(source, 'confirmMemory')).toMatch(/INSERT INTO ai_memories/);
    for (const name of ['listMemory', 'memoryContextFor', 'deleteMemoryEntry', 'resetMemory']) {
      expect(functionBody(source, name)).not.toMatch(/INSERT INTO|UPDATE ai_memories|\.insert\(/);
    }
  });

  it('the temporary-turn path writes nothing and never reaches the executor (AC-14, AC-18)', () => {
    const body = code(functionBody(read(join(HERE, 'turns.ts')), 'sendTemporaryTurn'));
    expect(body).not.toMatch(/getAiActionExecutor|interpretTurn|runLowRiskAction|applyProposedAction|persistTurn/);
    expect(body).not.toMatch(/INSERT|UPDATE|DELETE|getDb|transaction/);
    expect(body).not.toMatch(/memoryProposal\s*[:=]/);
  });

  it('the suggestion path is read-only and never reaches the executor (AC-15)', () => {
    const source = code(read(join(HERE, 'suggestions.ts')));
    expect(source).not.toMatch(/executor/i);
    const body = functionBody(source, 'listSuggestions');
    expect(body).not.toMatch(/INSERT|UPDATE|DELETE|\.insert\(|\.update\(|\.delete\(|notify\(/);
  });

  it('proactive suggestions are exactly the two finalized kinds — no provider availability/update kind', () => {
    const types = read(join(ROOT, 'lib', 'types', 'ai-assistant.ts'));
    expect(types).toMatch(/export type AiProactiveSuggestionKind = 'upcoming_booking' \| 'unfinished_request';/);
    expect(read(join(HERE, 'suggestions.ts'))).not.toMatch(/provider_availability|availability_notification/);
  });

  it('no provider-characteristics or communication-preferences memory key exists anywhere in this spec’s code', () => {
    const files = [...walk(HERE), join(ROOT, 'lib', 'types', 'ai-assistant.ts'), join(ROOT, 'drizzle', '0030_add_ai_conversation_memory.sql')];
    for (const file of files) {
      expect(code(read(file)), rel(file)).not.toMatch(/'[a-z_]*(characteristic|communication)[a-z_]*'/);
    }
  });
});
