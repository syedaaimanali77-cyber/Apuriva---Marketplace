import { afterEach, describe, expect, it } from 'vitest';
import { AiProviderConfigurationError } from '../errors';
import { AI_PROVIDER_ENV_VAR, registeredAiProviderNames, resolveAiProvider } from './index';

/** Spec 033 AC-2 / §3.4 — configuration-driven selection and both hard refusals. */
describe('lib/ai/provider selection (spec 033 AC-2)', () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOpenAi = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL };

  /**
   * A real adapter validates its own configuration when it is resolved (the OpenAI adapter needs
   * `OPENAI_API_KEY` and `OPENAI_MODEL` — see ./openai.ts), so the tests that walk EVERY registered
   * adapter give it placeholder settings. They only let the adapter be constructed: no test here
   * calls a real adapter's `complete()`, so nothing is ever sent anywhere with them.
   */
  const withRegisteredAdapterSettings = () => {
    process.env.OPENAI_API_KEY = 'placeholder-key-never-sent';
    process.env.OPENAI_MODEL = 'placeholder-model';
  };

  /** `NODE_ENV` is typed readonly by @types/node — the same cast every other sandbox-guard suite
   * in this repository already uses (lib/files/scanning/sandbox.test.ts). */
  const setNodeEnv = (value: string | undefined) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    setNodeEnv(originalNodeEnv);
    for (const [name, value] of [['OPENAI_API_KEY', originalOpenAi.key], ['OPENAI_MODEL', originalOpenAi.model]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('defaults to the sandbox adapter when AI_PROVIDER is unset or blank', () => {
    delete process.env.AI_PROVIDER;
    expect(resolveAiProvider().name).toBe('sandbox');
    process.env.AI_PROVIDER = '   ';
    expect(resolveAiProvider().name).toBe('sandbox');
  });

  it('selects by name, so swapping providers is a configuration change and nothing else', () => {
    withRegisteredAdapterSettings();
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
    withRegisteredAdapterSettings();
    for (const name of registeredAiProviderNames()) {
      process.env.AI_PROVIDER = name;
      const adapter = resolveAiProvider();
      expect(typeof adapter.name).toBe('string');
      expect(typeof adapter.model).toBe('string');
      expect(typeof adapter.promptVersion).toBe('string');
      expect(typeof adapter.isSandbox).toBe('boolean');

      // The RESULT half of the contract is asserted only where it can be asserted honestly. A
      // sandbox adapter answers from its own rules, so it runs here and its output is checked in
      // full. A real adapter's `complete()` is a call to its vendor over the network, paid for
      // with a credential this suite does not have and must never use: exercising it here would
      // either fabricate a configuration or make a live, billable request from a unit test.
      // Its own suite covers the call against a mocked SDK (e.g. ./openai.test.ts).
      if (!adapter.isSandbox) continue;

      const result = await adapter.complete({ task: 'summarization', input: 'hello', maxTokens: 50 });
      expect(typeof result.output).toBe('string');
      expect(Number.isInteger(result.tokensUsed)).toBe(true);
      expect(result.tokensUsed).toBeGreaterThanOrEqual(0);
      // The SANDBOX's own estimate is bounded by `maxTokens`. That is not a contract for a real
      // provider: `maxTokens` caps the OUTPUT it generates, while the `tokensUsed` it reports is the
      // provider's billed total, input plus output (./openai.ts), which may exceed it.
      expect(result.tokensUsed).toBeLessThanOrEqual(50);
    }
  });

  it('every registered adapter implements complete(), whether or not this suite may call it', () => {
    withRegisteredAdapterSettings();
    for (const name of registeredAiProviderNames()) {
      process.env.AI_PROVIDER = name;
      expect(typeof resolveAiProvider().complete).toBe('function');
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
