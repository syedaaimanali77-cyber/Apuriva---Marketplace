import { afterEach, describe, expect, it } from 'vitest';
import { AiProviderConfigurationError } from '../errors';
import { AI_PROVIDER_ENV_VAR, registeredAiProviderNames, resolveAiProvider } from './index';

/** Spec 033 AC-2 / §3.4 — configuration-driven selection and both hard refusals. */
describe('lib/ai/provider selection (spec 033 AC-2)', () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalNodeEnv = process.env.NODE_ENV;

  /** `NODE_ENV` is typed readonly by @types/node — the same cast every other sandbox-guard suite
   * in this repository already uses (lib/files/scanning/sandbox.test.ts). */
  const setNodeEnv = (value: string | undefined) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    setNodeEnv(originalNodeEnv);
  });

  it('defaults to the sandbox adapter when AI_PROVIDER is unset or blank', () => {
    delete process.env.AI_PROVIDER;
    expect(resolveAiProvider().name).toBe('sandbox');
    process.env.AI_PROVIDER = '   ';
    expect(resolveAiProvider().name).toBe('sandbox');
  });

  it('selects by name, so swapping providers is a configuration change and nothing else', () => {
    for (const name of registeredAiProviderNames()) {
      process.env.AI_PROVIDER = name;
      expect(resolveAiProvider().name).toBe(name);
    }
  });

  it('an unknown AI_PROVIDER throws instead of falling back to the sandbox', () => {
    process.env.AI_PROVIDER = 'sandbux';
    expect(() => resolveAiProvider()).toThrow(AiProviderConfigurationError);
    // The message names the variable and what is registered, so a typo is obvious.
    expect(() => resolveAiProvider()).toThrow(new RegExp(AI_PROVIDER_ENV_VAR));
  });

  it('a sandbox adapter is refused under NODE_ENV=production', () => {
    process.env.AI_PROVIDER = 'sandbox';
    setNodeEnv('production');
    expect(() => resolveAiProvider()).toThrow(AiProviderConfigurationError);
    expect(() => resolveAiProvider()).toThrow(/must never run in production/);
  });

  it('resolves fresh per call, so no warmed cache can bypass the production guard', () => {
    process.env.AI_PROVIDER = 'sandbox';
    setNodeEnv('test');
    expect(resolveAiProvider().isSandbox).toBe(true);
    setNodeEnv('production');
    expect(() => resolveAiProvider()).toThrow(AiProviderConfigurationError);
  });

  it('every registered adapter satisfies the same AiProviderAdapter contract', async () => {
    for (const name of registeredAiProviderNames()) {
      process.env.AI_PROVIDER = name;
      const adapter = resolveAiProvider();
      expect(typeof adapter.name).toBe('string');
      expect(typeof adapter.model).toBe('string');
      expect(typeof adapter.promptVersion).toBe('string');
      expect(typeof adapter.isSandbox).toBe('boolean');
      const result = await adapter.complete({ task: 'summarization', input: 'hello', maxTokens: 50 });
      expect(typeof result.output).toBe('string');
      expect(Number.isInteger(result.tokensUsed)).toBe(true);
      expect(result.tokensUsed).toBeGreaterThanOrEqual(0);
      expect(result.tokensUsed).toBeLessThanOrEqual(50);
    }
  });

  it('the sandbox claims no model capability: every task but search_intent is an explicit placeholder', async () => {
    process.env.AI_PROVIDER = 'sandbox';
    const adapter = resolveAiProvider();
    for (const task of ['faq_draft', 'conversation', 'summarization', 'translation'] as const) {
      const { output } = await adapter.complete({ task, input: 'anything at all', maxTokens: 100 });
      expect(output).toContain('[sandbox-ai: no model configured]');
    }
  });
});
