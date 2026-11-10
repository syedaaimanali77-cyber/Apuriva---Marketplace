import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 033 AC-1 and §4 "Retention and privacy" — a SOURCE-LEVEL guard, the idiom spec 020's
 * `payment-boundary.test.ts` and spec 021's `no-fabricated-success.test.ts` established, so these
 * invariants cannot rot as the spec grows.
 *
 * The invariants asserted here are exactly the ones spec 033 §6 lists:
 *   - only `lib/ai/provider/` may import a vendor SDK or read an AI credential;
 *   - no module outside `lib/ai/` reaches a provider adapter, a provider name or a model name;
 *   - `AiCompletionResult` exposes no provider/model, and no customer-facing route serialises one;
 *   - no `lib/ai` module persists or logs prompt/response text;
 *   - the transactional modules import nothing from `lib/ai` at all.
 */
const ROOT = join(__dirname, '..', '..');
const AI_DIR = join(ROOT, 'lib', 'ai');
const PROVIDER_DIR = join(AI_DIR, 'provider');
const API_V1_DIR = join(ROOT, 'app', 'api', 'v1');
const ADMIN_AI_DIR = join(API_V1_DIR, 'admin', 'ai');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function isProduction(file: string): boolean {
  return !/\.test\.tsx?$/.test(file) && !/test-support\.ts$/.test(file);
}

/**
 * These assertions are about CODE, not prose. Every module in this spec documents the boundary it
 * respects — `types.ts`'s header says in so many words that the result carries no provider — so
 * matching raw file text would make a correct file fail for describing its own correctness.
 * Comments are stripped first, and only the remaining code is searched.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const AI_FILES = sourceFiles(AI_DIR).filter(isProduction);
const NON_PROVIDER_AI_FILES = AI_FILES.filter((file) => !file.startsWith(PROVIDER_DIR));
const APP_AND_LIB_FILES = [...sourceFiles(join(ROOT, 'lib')), ...sourceFiles(join(ROOT, 'app'))].filter(isProduction);
const OUTSIDE_AI_FILES = APP_AND_LIB_FILES.filter((file) => !file.startsWith(AI_DIR));

/** Import specifiers of packages that would be an AI vendor SDK. None exists in this repository —
 * `package.json` has no AI dependency — so the list is what a future one would be added under. */
const VENDOR_SDK_PATTERN =
  /from\s+['"](@anthropic-ai\/[\w.-]+|@google\/[\w.-]*gen[\w.-]*|@azure\/openai|openai|anthropic|cohere-ai|@mistralai\/[\w.-]+|replicate|groq-sdk|@aws-sdk\/client-bedrock[\w-]*)['"]/;
const AI_CREDENTIAL_PATTERN = /process\.env\.AI_[A-Z0-9_]*(KEY|SECRET|TOKEN)\b/;

describe('spec 033 — the lib/ai boundary (AC-1)', () => {
  it('has production sources to check', () => {
    expect(AI_FILES.length).toBeGreaterThan(8);
    expect(NON_PROVIDER_AI_FILES.length).toBeGreaterThan(5);
    expect(OUTSIDE_AI_FILES.length).toBeGreaterThan(50);
  });

  it('only lib/ai/provider may import a vendor SDK or read an AI credential', () => {
    const offenders: string[] = [];
    for (const file of APP_AND_LIB_FILES) {
      if (file.startsWith(PROVIDER_DIR)) continue;
      const source = code(file);
      if (VENDOR_SDK_PATTERN.test(source)) offenders.push(`${relative(ROOT, file)} (vendor SDK import)`);
      if (AI_CREDENTIAL_PATTERN.test(source)) offenders.push(`${relative(ROOT, file)} (AI credential read)`);
    }
    expect(offenders).toEqual([]);
  });

  it('no module outside lib/ai references a provider adapter, provider name or model name', () => {
    const offenders: string[] = [];
    for (const file of OUTSIDE_AI_FILES) {
      const source = code(file);
      if (/lib\/ai\/provider|from\s+['"].*\/provider\/sandbox['"]/.test(source)) {
        offenders.push(`${relative(ROOT, file)} (imports the provider boundary)`);
      }
      if (/AiProviderAdapter|resolveAiProvider|getSandboxAiProvider/.test(source)) {
        offenders.push(`${relative(ROOT, file)} (references an adapter)`);
      }
      if (/process\.env\.AI_PROVIDER\b/.test(source)) {
        offenders.push(`${relative(ROOT, file)} (reads AI_PROVIDER)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lib/ai exports no provider adapter through its barrel', () => {
    const barrel = code(join(AI_DIR, 'index.ts'));
    expect(barrel).not.toMatch(/\.\/provider/);
  });

  it('AiCompletionResult declares no provider or model field', () => {
    const types = code(join(AI_DIR, 'types.ts'));
    const block = /export interface AiCompletionResult \{([\s\S]*?)\}/.exec(types)?.[1] ?? '';
    expect(block).not.toBeFalsy();
    expect(block).not.toMatch(/provider/i);
    expect(block).not.toMatch(/model/i);
  });

  it('no route outside app/api/v1/admin/ai serialises a provider or model name', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(API_V1_DIR).filter(isProduction)) {
      if (file.startsWith(ADMIN_AI_DIR)) continue;
      if (/providerName|modelName|byProvider/.test(code(file))) offenders.push(relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('no lib/ai module persists prompt or response text', () => {
    const offenders: string[] = [];
    // The only columns lib/ai writes are the accounting ones. A prompt/response column would have
    // to be named, so assert the absence of any such name in an insert/values position.
    for (const file of AI_FILES) {
      const source = code(file);
      if (/\b(prompt|promptText|responseText|completionText|outputText|inputText|messageBody)\s*:/.test(source)) {
        offenders.push(relative(ROOT, file));
      }
      // `input`/`output` are legitimate in-memory field names; what must never happen is either of
      // them reaching a database insert.
      // `[\s\S]` rather than the `s` flag: tsconfig targets below es2018, where `s` is unavailable.
      if (/\.values\(\s*\{[\s\S]*?\b(input|output)\b\s*:/.test(source)) offenders.push(`${relative(ROOT, file)} (insert)`);
    }
    expect(offenders).toEqual([]);
  });

  it('the ai_usage_events table itself has no prompt or response column', () => {
    const schema = readFileSync(join(ROOT, 'lib', 'db', 'schema.ts'), 'utf8');
    const block = /export const aiUsageEvents = pgTable\(([\s\S]*?)\n\);/.exec(schema)?.[1] ?? '';
    expect(block).not.toBeFalsy();
    for (const forbidden of ['prompt', 'response', 'completion', 'output', 'message', 'content']) {
      expect(block.toLowerCase()).not.toContain(`'${forbidden}`);
    }
  });

  it('no lib/ai module logs the prompt or the response', () => {
    const offenders: string[] = [];
    for (const file of AI_FILES) {
      for (const line of code(file).split('\n')) {
        if (!/console\.(log|error|warn|info)/.test(line)) continue;
        if (/\b(input|output|text|prompt|response)\b/.test(line)) offenders.push(`${relative(ROOT, file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the transactional modules import nothing from lib/ai (AC-3, structurally)', () => {
    const offenders: string[] = [];
    for (const domain of ['requests', 'bookings', 'payments', 'payouts', 'messaging']) {
      for (const file of sourceFiles(join(ROOT, 'lib', domain)).filter(isProduction)) {
        if (/from\s+['"]@\/lib\/ai/.test(code(file))) offenders.push(relative(ROOT, file).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('abuse detection enforces nothing: lib/ai suspends, bans, blocks and throttles no one', () => {
    const offenders: string[] = [];
    for (const file of AI_FILES) {
      const source = code(file);
      if (/\b(suspend|ban|block|deactivate|disableAccount)\w*\s*\(/i.test(source)) offenders.push(relative(ROOT, file));
      // A flag must never be an UPDATE against a user/session row.
      if (/update\(\s*(users|sessions)\s*\)/.test(source)) offenders.push(`${relative(ROOT, file)} (writes a user/session row)`);
    }
    expect(offenders).toEqual([]);
  });
});
