import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseNameReader } from '@/lib/demo/guards';
import { DemoOperatorRefusal, reseedDemoEnvironment } from '@/lib/demo/operator';

/**
 * Spec 045 §3.5 — the reseed's guards. The destructive steps are injected spies, so this suite never drops or
 * creates any database (the developer's local database included); the non-demo count is stubbed too.
 */
describe('scripts/demo-reseed — reseedDemoEnvironment guards (spec 045 §3.5)', () => {
  const saved = { APP_ENV: process.env.APP_ENV, DEMO_MODE_ENABLED: process.env.DEMO_MODE_ENABLED };
  let dropAndRecreate: ReturnType<typeof vi.fn<(databaseName: string) => Promise<void>>>;
  let migrate: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    process.env.APP_ENV = 'staging';
    process.env.DEMO_MODE_ENABLED = 'true';
    vi.spyOn(databaseNameReader, 'read').mockReturnValue('apuriva_demo');
    dropAndRecreate = vi.fn<(databaseName: string) => Promise<void>>().mockResolvedValue(undefined);
    migrate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const run = (nonDemo = 0) => reseedDemoEnvironment({ dropAndRecreate, migrate, readNonDemoCount: async () => nonDemo });

  it('drops and recreates only the _demo database, then migrates, and logs demo.environment_reseeded', async () => {
    const log = vi.spyOn(console, 'log');
    await expect(run()).resolves.toEqual({ databaseName: 'apuriva_demo' });
    expect(dropAndRecreate).toHaveBeenCalledWith('apuriva_demo');
    expect(migrate).toHaveBeenCalledOnce();
    expect(log.mock.calls.some(([line]) => String(line).includes('"event":"demo.environment_reseeded"'))).toBe(true);
  });

  it.each([
    ['APP_ENV=production', () => (process.env.APP_ENV = 'production'), 'production'],
    ['the flag off', () => (process.env.DEMO_MODE_ENABLED = 'false'), 'flag_off'],
    ['a database not ending in _demo', () => vi.spyOn(databaseNameReader, 'read').mockReturnValue('apuriva'), 'wrong_database'],
  ])('refuses with %s, touching nothing', async (_label, arrange, reason) => {
    arrange();
    await expect(run()).rejects.toMatchObject({ reason });
    expect(dropAndRecreate).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('refuses while any non-demo user exists, and never deletes it', async () => {
    const refusal = await run(1).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(DemoOperatorRefusal);
    expect((refusal as DemoOperatorRefusal).reason).toBe('non_demo_users_present');
    expect(dropAndRecreate).not.toHaveBeenCalled();
  });
});
