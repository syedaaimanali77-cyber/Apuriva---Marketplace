import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/feature-flags/resolve', () => ({ isFeatureEnabled: flags.isFeatureEnabled }));

import {
  assertDemoAvailable,
  databaseNameReader,
  demoAvailability,
  demoUnavailableError,
  isDemoAvailable,
  isDemoDatabaseName,
  shouldShowDemoBanner,
} from './guards';

/** Spec 045 §3.1 / §3.6 — the demo-environment checks, their order, and their refusals. */
describe('lib/demo/guards', () => {
  const saved = { APP_ENV: process.env.APP_ENV, DATABASE_URL: process.env.DATABASE_URL };

  beforeEach(() => {
    process.env.APP_ENV = 'staging';
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apuriva_demo';
    flags.isFeatureEnabled.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    flags.isFeatureEnabled.mockReset();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('the database-name guard (condition 3, the _test idiom)', () => {
    it.each([
      ['apuriva_demo', true],
      ['x_demo', true],
      ['_demo', false],
      ['apuriva', false],
      ['apuriva_test', false],
      ['apuriva_demo_old', false],
      ['apuriva_DEMO', false],
      ['', false],
    ])('%s → %s', (name, expected) => {
      expect(isDemoDatabaseName(name)).toBe(expected);
    });

    it('reads the database name from DATABASE_URL, decoded, and an absent or malformed URL as no name', () => {
      expect(databaseNameReader.read()).toBe('apuriva_demo');
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/my%5Fdemo';
      expect(databaseNameReader.read()).toBe('my_demo');
      delete process.env.DATABASE_URL;
      expect(databaseNameReader.read()).toBe('');
      process.env.DATABASE_URL = 'not a url';
      expect(databaseNameReader.read()).toBe('');
    });
  });

  describe('demoAvailability — conditions 1, 2, 3 in that order', () => {
    it('is available only when all three hold', async () => {
      await expect(demoAvailability()).resolves.toEqual({ available: true });
    });

    it('production first: the flag is never even read', async () => {
      process.env.APP_ENV = 'production';
      await expect(demoAvailability()).resolves.toEqual({ available: false, reason: 'production' });
      expect(flags.isFeatureEnabled).not.toHaveBeenCalled();
    });

    it('the flag next, before the database name — a normal deployment never logs demo.misconfigured', async () => {
      flags.isFeatureEnabled.mockResolvedValue(false);
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apuriva';
      const log = vi.spyOn(console, 'log');
      await expect(demoAvailability()).resolves.toEqual({ available: false, reason: 'flag_off' });
      expect(flags.isFeatureEnabled).toHaveBeenCalledWith('demo-mode');
      expect(log).not.toHaveBeenCalled();
    });

    it('the database name last, logging demo.misconfigured', async () => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apuriva_staging';
      const log = vi.spyOn(console, 'log');
      await expect(demoAvailability()).resolves.toEqual({ available: false, reason: 'wrong_database' });
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'demo.misconfigured', reason: 'database_name' }));
    });

    it('a misconfigured APP_ENV is an error to the routes, and "unavailable" to renderers', async () => {
      process.env.APP_ENV = 'prod';
      await expect(demoAvailability()).rejects.toThrow(/APP_ENV/);
      await expect(isDemoAvailable()).resolves.toBe(false);
    });
  });

  describe('refusals (§3.6)', () => {
    it('maps production to 403 DEMO_NOT_AVAILABLE_IN_PRODUCTION and the rest to 403 DEMO_MODE_DISABLED', () => {
      expect(demoUnavailableError('production')).toMatchObject({ status: 403, code: 'DEMO_NOT_AVAILABLE_IN_PRODUCTION' });
      expect(demoUnavailableError('flag_off')).toMatchObject({ status: 403, code: 'DEMO_MODE_DISABLED' });
      expect(demoUnavailableError('wrong_database')).toMatchObject({ status: 403, code: 'DEMO_MODE_DISABLED' });
    });

    it('assertDemoAvailable throws the mapped refusal and passes when available', async () => {
      await expect(assertDemoAvailable()).resolves.toBeUndefined();
      flags.isFeatureEnabled.mockResolvedValue(false);
      await expect(assertDemoAvailable()).rejects.toMatchObject({ code: 'DEMO_MODE_DISABLED' });
    });
  });

  describe('the banner condition (§5)', () => {
    it('shows with the flag on outside production, and never in production', async () => {
      await expect(shouldShowDemoBanner()).resolves.toBe(true);
      process.env.APP_ENV = 'production';
      await expect(shouldShowDemoBanner()).resolves.toBe(false);
    });

    it('fails closed when the flag store cannot be read', async () => {
      flags.isFeatureEnabled.mockRejectedValue(new Error('database unreachable'));
      await expect(shouldShowDemoBanner()).resolves.toBe(false);
    });
  });
});
