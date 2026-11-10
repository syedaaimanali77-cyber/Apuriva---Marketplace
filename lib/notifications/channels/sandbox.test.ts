import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR,
  NotificationChannelProviderUnavailable,
  SANDBOX_NOTIFICATION_REFERENCE_PREFIX,
  getSandboxChannelRecords,
  resetSandboxChannelRecords,
  resolveNotificationChannelAdapters,
} from './index';

const originalProvider = process.env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR];
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/** Spec 026 AC-10 — the adapter seam, the sandbox, and the production guard. */
describe('notification channel adapters (spec 026 AC-10)', () => {
  afterEach(() => {
    if (originalProvider === undefined) delete process.env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR];
    else process.env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR] = originalProvider;
    setNodeEnv(originalNodeEnv);
    resetSandboxChannelRecords();
  });

  it('the sandbox records rather than fabricates', async () => {
    setNodeEnv('test');
    delete process.env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR];
    const adapters = resolveNotificationChannelAdapters();
    expect(Object.keys(adapters).sort()).toEqual(['email', 'push', 'sms']);

    const result = await adapters.email!.deliver({
      notificationId: 'n1',
      channel: 'email',
      recipientUserId: 'u1',
      title: 'Secret title',
      body: 'Secret body',
    });
    expect(result.outcome).toBe('delivered');
    expect(result.providerReference).toMatch(new RegExp(`^${SANDBOX_NOTIFICATION_REFERENCE_PREFIX}`));

    // Its "delivery" is exactly the record — and the record holds no title or body.
    const records = getSandboxChannelRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ channel: 'email', notificationId: 'n1', providerReference: result.providerReference });
    expect(JSON.stringify(records)).not.toContain('Secret');
  });

  it('the factory refuses a sandbox under NODE_ENV=production', () => {
    process.env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('production');
    expect(() => resolveNotificationChannelAdapters()).toThrow(NotificationChannelProviderUnavailable);
    expect(() => resolveNotificationChannelAdapters()).toThrow(/sandbox and must never run in production/);
  });

  it('refuses an unknown provider name rather than falling back to the sandbox', () => {
    process.env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR] = 'some-vendor-we-have-no-account-with';
    setNodeEnv('test');
    expect(() => resolveNotificationChannelAdapters()).toThrow(/not a known notification channel provider/);
  });

  it('re-reads configuration on every call', () => {
    process.env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('test');
    expect(() => resolveNotificationChannelAdapters()).not.toThrow();
    setNodeEnv('production');
    expect(() => resolveNotificationChannelAdapters()).toThrow(NotificationChannelProviderUnavailable);
  });
});
