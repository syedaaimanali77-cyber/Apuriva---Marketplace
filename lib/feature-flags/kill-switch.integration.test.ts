import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminWithRole } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import { completeAi } from '@/lib/ai/complete';
import { AiUnavailableError } from '@/lib/ai/errors';
import { createAiUser, resetAiState } from '@/lib/ai/ai-test-support';
import { createConversation } from '@/lib/ai-assistant/conversations';
import { toggleFeatureFlag } from './admin';
import { isDatabaseReachable, restoreStoredFlags, storedFlag, useFlagEnvironment } from './feature-flags-test-support';

/**
 * Spec 041 AC-4 / §3.7 — a kill switch turned off stops its feature for the NEXT request: no deploy,
 * no restart, no process-local cache. Worker runs as `production` with `ai-assistant` and
 * `ai-conversational-assistant` (no other spec 041 file changes those pairs); the sandbox AI provider
 * is used so a success is a real completion, not a configuration error.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('kill switches take effect immediately (spec 041 AC-4)', { timeout: 120_000 }, () => {
  useFlagEnvironment('production');
  restoreStoredFlags([
    ['ai-assistant', 'production'],
    ['ai-conversational-assistant', 'production'],
  ]);
  const savedProvider = process.env.AI_PROVIDER;
  let superAdmin: Awaited<ReturnType<typeof adminWithRole>>;
  let content: Awaited<ReturnType<typeof adminWithRole>>;

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'sandbox';
    superAdmin = await adminWithRole('super_admin');
    content = await adminWithRole('content_admin');
  }, 120_000);

  afterAll(() => {
    if (savedProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = savedProvider;
  });

  async function set(key: 'ai-assistant' | 'ai-conversational-assistant', enabled: boolean, userId: string): Promise<void> {
    const current = await storedFlag(key, 'production');
    if (current.enabled === enabled) return;
    await toggleFeatureFlag(userId, key, { environment: 'production', enabled, expectedVersion: current.version, reason: `AC-4 ${key} ${enabled}` });
  }

  it('ai-assistant off: the very next completeAi() throws AiUnavailableError; back on: it completes', async () => {
    resetAiState();
    const subject = { kind: 'user' as const, userId: await createAiUser() };
    await set('ai-assistant', true, superAdmin.userId);
    await expect(completeAi({ task: 'summarization', input: `before ${randomUUID()}`, subject })).resolves.toBeDefined();

    await set('ai-assistant', false, superAdmin.userId);
    await expect(completeAi({ task: 'summarization', input: `during ${randomUUID()}`, subject })).rejects.toBeInstanceOf(AiUnavailableError);

    await set('ai-assistant', true, superAdmin.userId);
    await expect(completeAi({ task: 'summarization', input: `after ${randomUUID()}`, subject })).resolves.toBeDefined();
  });

  it('either AI flag off: Ask Apuriva refuses new conversations with 503 AI_PROVIDER_UNAVAILABLE', async () => {
    const userId = await createAiUser();
    await set('ai-assistant', true, superAdmin.userId);
    await set('ai-conversational-assistant', false, content.userId);
    await expect(createConversation(userId, randomUUID(), {})).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', status: 503 });

    await set('ai-conversational-assistant', true, content.userId);
    await expect(createConversation(userId, randomUUID(), {})).resolves.toMatchObject({ replayed: false });

    await set('ai-assistant', false, superAdmin.userId);
    await expect(createConversation(userId, randomUUID(), {})).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    await set('ai-assistant', true, superAdmin.userId);
  });

  it('a deploy-level env override still wins over the stored value (D-3)', async () => {
    const subject = { kind: 'user' as const, userId: await createAiUser() };
    await set('ai-assistant', true, superAdmin.userId);
    process.env.AI_ASSISTANT_ENABLED = 'false';
    try {
      await expect(completeAi({ task: 'summarization', input: `pinned ${randomUUID()}`, subject })).rejects.toBeInstanceOf(AiUnavailableError);
    } finally {
      delete process.env.AI_ASSISTANT_ENABLED;
    }
  });
});
