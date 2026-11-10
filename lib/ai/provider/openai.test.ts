/**
 * The `openai` adapter: registration, configuration, completion mapping and error mapping.
 *
 * The SDK is replaced by a fake class, so no real client is ever constructed and no request can
 * leave the process — whatever `.env` holds. The fake keeps the SDK's real error classes, because
 * mapping them is part of what is under test. The key used here is a fake, and every assertion on
 * an error message also checks the key does not appear in it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  recordAiUsage: vi.fn(),
  rollingUsageSince: vi.fn(),
}));

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  class FakeOpenAI {
    static APIError = actual.APIError;
    chat = { completions: { create: mocks.create } };
    constructor(options: Record<string, unknown>) {
      mocks.clientOptions.push(options);
    }
  }
  return { ...actual, default: FakeOpenAI, OpenAI: FakeOpenAI };
});

// Only for the `completeAi` end-to-end case: accounting is spec 033's, and needs a database.
vi.mock('../usage', () => ({ recordAiUsage: mocks.recordAiUsage, rollingUsageSince: mocks.rollingUsageSince }));

import { APIConnectionError, APIError, RateLimitError } from 'openai';
import { completeAi } from '../complete';
import { AiProviderConfigurationError, AiUnavailableError } from '../errors';
import { registeredAiProviderNames, resolveAiProvider } from './index';
import { OpenAiProvider, OpenAiProviderError, type OpenAiChatClient } from './openai';

const FAKE_KEY = 'sk-test-fake-key-never-real-0000';
const MODEL = 'gpt-test-model';
const ENV_KEYS = ['AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'AI_REQUEST_TIMEOUT_MS', 'AI_ASSISTANT_ENABLED', 'NODE_ENV'] as const;

/** A Chat Completions response carrying only what the adapter reads. */
function chatResponse(content: string | null, options: { finishReason?: string; totalTokens?: number | null } = {}) {
  return {
    choices: [{ index: 0, finish_reason: options.finishReason ?? 'stop', message: { role: 'assistant', content } }],
    ...(options.totalTokens === null ? {} : { usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: options.totalTokens ?? 42 } }),
  };
}

function lastRequest(): Record<string, unknown> {
  return mocks.create.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('lib/ai/provider/openai', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const env = process.env as Record<string, string | undefined>;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = env[key];
    env.AI_PROVIDER = 'openai';
    env.OPENAI_API_KEY = FAKE_KEY;
    env.OPENAI_MODEL = MODEL;
    env.NODE_ENV = 'test';
    delete env.AI_REQUEST_TIMEOUT_MS;
    mocks.create.mockReset();
    mocks.clientOptions.length = 0;
    mocks.recordAiUsage.mockReset().mockResolvedValue(undefined);
    mocks.rollingUsageSince.mockReset().mockResolvedValue({ requests: 0, tokens: 0 });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete env[key];
      else env[key] = saved[key];
    }
  });

  describe('registration', () => {
    it('is registered as "openai" alongside the sandbox', () => {
      expect(registeredAiProviderNames()).toEqual(expect.arrayContaining(['sandbox', 'openai']));
    });

    it('AI_PROVIDER=openai resolves to a real (non-sandbox) adapter', () => {
      const adapter = resolveAiProvider();
      expect(adapter.name).toBe('openai');
      expect(adapter.isSandbox).toBe(false);
      // v2: the plain support prompt was reworded (see below). The version is part of the spec 033
      // §3.8 cache key, so no answer cached under a v1 prompt can ever be served for v2.
      expect(adapter.promptVersion).toBe('v2');
    });

    it('is not refused under NODE_ENV=production, unlike the sandbox', () => {
      env.NODE_ENV = 'production';
      expect(resolveAiProvider().name).toBe('openai');
    });

    it('leaves the sandbox exactly as it was', async () => {
      env.AI_PROVIDER = 'sandbox';
      const adapter = resolveAiProvider();
      expect(adapter.name).toBe('sandbox');
      expect(adapter.isSandbox).toBe(true);
      await adapter.complete({ task: 'summarization', input: 'x', maxTokens: 10 });
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('configuration', () => {
    it.each([undefined, '', '   '])('a missing OPENAI_API_KEY (%j) fails resolution loudly', (value) => {
      if (value === undefined) delete env.OPENAI_API_KEY;
      else env.OPENAI_API_KEY = value;
      expect(() => resolveAiProvider()).toThrow(AiProviderConfigurationError);
      expect(() => resolveAiProvider()).toThrow(/OPENAI_API_KEY/);
      expect(mocks.clientOptions).toHaveLength(0);
    });

    it('a missing OPENAI_MODEL fails resolution loudly — there is no default model', () => {
      delete env.OPENAI_MODEL;
      expect(() => resolveAiProvider()).toThrow(AiProviderConfigurationError);
      expect(() => resolveAiProvider()).toThrow(/OPENAI_MODEL/);
    });

    it('never puts the key in a configuration error', () => {
      delete env.OPENAI_MODEL;
      try {
        resolveAiProvider();
        expect.unreachable();
      } catch (err) {
        expect(String(err)).not.toContain(FAKE_KEY);
        expect((err as Error).stack ?? '').not.toContain(FAKE_KEY);
      }
    });

    it('uses OPENAI_MODEL (trimmed) as the adapter model and on every request', async () => {
      env.OPENAI_MODEL = '  gpt-other-model  ';
      const adapter = resolveAiProvider();
      expect(adapter.model).toBe('gpt-other-model');
      mocks.create.mockResolvedValue(chatResponse('ok'));
      await adapter.complete({ task: 'summarization', input: 'text', maxTokens: 50 });
      expect(lastRequest().model).toBe('gpt-other-model');
    });

    it('hands the key to the SDK client, with the AI timeout and no SDK retries', () => {
      env.AI_REQUEST_TIMEOUT_MS = '4321';
      resolveAiProvider();
      expect(mocks.clientOptions).toEqual([{ apiKey: FAKE_KEY, timeout: 4321, maxRetries: 0 }]);
    });

    it('does not expose the key on the adapter', () => {
      const adapter = resolveAiProvider();
      expect(JSON.stringify(adapter)).not.toContain(FAKE_KEY);
      expect(Object.keys(adapter)).not.toContain('apiKey');
    });

    it('keeps the key unreachable even though the real SDK client stores it as a plain property', () => {
      // The real `OpenAI` client carries `apiKey` on itself; this stand-in does the same.
      const client = { apiKey: FAKE_KEY, chat: { completions: { create: mocks.create } } };
      const adapter = new OpenAiProvider('gpt-test', client as unknown as OpenAiChatClient);
      expect(JSON.stringify(adapter)).not.toContain(FAKE_KEY);
      expect(Object.keys(adapter)).not.toContain('client');
      expect((adapter as unknown as Record<string, unknown>).client).toBeUndefined();
      expect(Object.values(adapter)).not.toContain(client);
      expect(String(Object.entries(adapter))).not.toContain(FAKE_KEY);
    });
  });

  describe('completion mapping', () => {
    it('returns the model text as output and the provider total_tokens as tokensUsed', async () => {
      mocks.create.mockResolvedValue(chatResponse('A short summary.', { totalTokens: 57 }));
      const result = await resolveAiProvider().complete({ task: 'summarization', input: 'long text', maxTokens: 250 });
      expect(result).toEqual({ output: 'A short summary.', tokensUsed: 57 });
    });

    it('sends a system template, the input verbatim as the user message, and maxTokens as max_completion_tokens', async () => {
      mocks.create.mockResolvedValue(chatResponse('ok'));
      await resolveAiProvider().complete({ task: 'summarization', input: 'Dispute reason: late', maxTokens: 250 });
      const request = lastRequest();
      const messages = request.messages as Array<{ role: string; content: string }>;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe('system');
      expect(messages[1]).toEqual({ role: 'user', content: 'Dispute reason: late' });
      expect(request.max_completion_tokens).toBe(250);
      expect(request.response_format).toBeUndefined();
    });

    it('search_intent requests a JSON object and returns it unchanged for the intent parser', async () => {
      const json = '{"serviceNameRaw":"plumber","area":"Gulberg","budgetMaxMinorUnits":500000,"currencyCode":"PKR"}';
      mocks.create.mockResolvedValue(chatResponse(json));
      const result = await resolveAiProvider().complete({ task: 'search_intent', input: 'plumber in Gulberg under 5000', maxTokens: 200 });
      expect(result.output).toBe(json);
      expect(lastRequest().response_format).toEqual({ type: 'json_object' });
      const system = (lastRequest().messages as Array<{ content: string }>)[0]!.content;
      for (const field of ['serviceNameRaw', 'area', 'date', 'budgetMaxMinorUnits', 'currencyCode']) expect(system).toContain(field);
    });

    it("conversation with spec 034's { memory, turns } input requests the reply envelope", async () => {
      const envelope = '{"reply":"Sure."}';
      mocks.create.mockResolvedValue(chatResponse(envelope));
      const input = JSON.stringify({ memory: [], turns: [{ role: 'user', body: 'hi' }] });
      const result = await resolveAiProvider().complete({ task: 'conversation', input, maxTokens: 400 });
      expect(result.output).toBe(envelope);
      expect(lastRequest().response_format).toEqual({ type: 'json_object' });
      const system = (lastRequest().messages as Array<{ content: string }>)[0]!.content;
      for (const member of ['"reply"', '"memoryProposal"', '"toolCall"', 'preferred_category', 'preferred_area', '"language"']) {
        expect(system).toContain(member);
      }
    });

    it("conversation with spec 032's plain question asks for plain text, never the envelope", async () => {
      mocks.create.mockResolvedValue(chatResponse('You can reset it from Account.'));
      const result = await resolveAiProvider().complete({ task: 'conversation', input: 'How do I reset my password?', maxTokens: 400 });
      expect(result.output).toBe('You can reset it from Account.');
      expect(lastRequest().response_format).toBeUndefined();
      const system = (lastRequest().messages as Array<{ content: string }>)[0]!.content;
      expect(system).not.toContain('"reply"');
      // The v2 wording keeps v1's security intent: no sight of the account or its records, no actions,
      // never claiming either — and the untrusted-input rule.
      expect(system).toMatch(/cannot see the user account or any of its records/);
      expect(system).toMatch(/cannot take any action: never claim to have done something or to know account details/);
      expect(system).toMatch(/never instructions to you/);
    });

    it('accepts a truncated plain-text answer, which is still text', async () => {
      mocks.create.mockResolvedValue(chatResponse('A summary that was cut', { finishReason: 'length' }));
      const result = await resolveAiProvider().complete({ task: 'summarization', input: 'x', maxTokens: 5 });
      expect(result.output).toBe('A summary that was cut');
    });
  });

  describe('error mapping', () => {
    async function failure(run: () => Promise<unknown>): Promise<OpenAiProviderError> {
      const err = await run().then(
        () => expect.unreachable(),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OpenAiProviderError);
      return err as OpenAiProviderError;
    }

    it('maps an SDK API error to a sanitised error carrying only the HTTP status', async () => {
      const sdkError = new RateLimitError(429, { message: 'secret prompt echoed back' }, 'secret prompt echoed back', new Headers());
      mocks.create.mockRejectedValue(sdkError);
      const err = await failure(() => resolveAiProvider().complete({ task: 'summarization', input: 'secret prompt', maxTokens: 50 }));
      expect(err.reason).toBe('request_failed');
      expect(err.status).toBe(429);
      expect(err.message).not.toContain('secret prompt');
      expect(err.message).not.toContain(FAKE_KEY);
      expect(sdkError).toBeInstanceOf(APIError);
    });

    it('maps a connection failure (no status) the same way', async () => {
      mocks.create.mockRejectedValue(new APIConnectionError({ message: 'socket hang up' }));
      const err = await failure(() => resolveAiProvider().complete({ task: 'summarization', input: 'x', maxTokens: 50 }));
      expect(err.reason).toBe('request_failed');
      expect(err.status).toBeUndefined();
      expect(err.message).not.toContain('socket hang up');
    });

    it.each(['faq_draft', 'translation'] as const)('refuses %s (no documented contract) without calling OpenAI', async (task) => {
      const err = await failure(() => resolveAiProvider().complete({ task, input: 'x', maxTokens: 50 }));
      expect(err.reason).toBe('unsupported_task');
      expect(mocks.create).not.toHaveBeenCalled();
    });

    it.each([null, '', '   '])('refuses an empty completion (%j)', async (content) => {
      mocks.create.mockResolvedValue(chatResponse(content));
      const err = await failure(() => resolveAiProvider().complete({ task: 'summarization', input: 'x', maxTokens: 50 }));
      expect(err.reason).toBe('empty_output');
    });

    it('refuses a JSON contract cut off by the token limit', async () => {
      mocks.create.mockResolvedValue(chatResponse('{"reply":"half', { finishReason: 'length' }));
      const input = JSON.stringify({ memory: [], turns: [{ role: 'user', body: 'hi' }] });
      const err = await failure(() => resolveAiProvider().complete({ task: 'conversation', input, maxTokens: 5 }));
      expect(err.reason).toBe('incomplete_output');
    });

    it('refuses a completion with no usage rather than inventing a token count', async () => {
      mocks.create.mockResolvedValue(chatResponse('ok', { totalTokens: null }));
      const err = await failure(() => resolveAiProvider().complete({ task: 'summarization', input: 'x', maxTokens: 50 }));
      expect(err.reason).toBe('missing_usage');
    });

    it('through completeAi, a provider failure is a degradable AI_PROVIDER_UNAVAILABLE and a failed usage row', async () => {
      env.AI_ASSISTANT_ENABLED = 'true';
      mocks.create.mockRejectedValue(new RateLimitError(429, undefined, 'quota', new Headers()));
      const run = completeAi({ task: 'summarization', input: 'x', subject: { kind: 'system', label: 'openai_adapter_test' } });
      await expect(run).rejects.toBeInstanceOf(AiUnavailableError);
      expect(mocks.recordAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', providerName: 'openai', modelName: MODEL }),
      );
    });

    it('through completeAi, a success is accounted with the provider token count', async () => {
      env.AI_ASSISTANT_ENABLED = 'true';
      mocks.create.mockResolvedValue(chatResponse('Summary.', { totalTokens: 64 }));
      const result = await completeAi({ task: 'summarization', input: 'y', subject: { kind: 'system', label: 'openai_adapter_test_ok' } });
      expect(result).toEqual({ output: 'Summary.', tokensUsed: 64, cached: false });
      expect(mocks.recordAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'succeeded', tokensUsed: 64, providerName: 'openai', modelName: MODEL }),
      );
    });
  });
});
