import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProductionDeployment } from './environment';
import { PAYMENT_PROVIDER_ENV_VAR, resolvePaymentProvider } from '@/lib/payments/provider';
import { PAYOUT_PROVIDER_ENV_VAR, resolvePayoutProvider } from '@/lib/payments/provider/payout-factory';
import { NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR, resolveNotificationChannelAdapters } from '@/lib/notifications/channels';
import { FILE_STORAGE_PROVIDER_ENV_VAR, resolveFileStorageAdapter } from '@/lib/files/storage';
import { LOCAL_STORAGE_ADAPTER_NAME } from '@/lib/files/storage/local';
import { FILE_SCANNER_ENV_VAR, resolveFileScanner } from '@/lib/files/scanning';
import { SANDBOX_SCANNER_NAME } from '@/lib/files/scanning/sandbox';
import { AI_PROVIDER_ENV_VAR, resolveAiProvider } from '@/lib/ai/provider';
import { useTemporaryStorageDir } from '@/lib/files/files-test-support';

/**
 * DEP-1 (spec 045 §8; approved 2026-11-10 for specs 021, 024, 026, 027 and 033). Every sandbox adapter
 * refuses to run in a PRODUCTION deployment, now decided by `APP_ENV` (spec 041), not `NODE_ENV`:
 * every hosted server sets `NODE_ENV=production`, and only `APP_ENV` tells staging and a demo
 * deployment from production. These cases run each factory exactly as a hosted server would, with
 * `NODE_ENV=production`.
 */
const env = process.env as Record<string, string | undefined>;
const FACTORY_VARS = [
  PAYMENT_PROVIDER_ENV_VAR,
  PAYOUT_PROVIDER_ENV_VAR,
  NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR,
  FILE_STORAGE_PROVIDER_ENV_VAR,
  FILE_SCANNER_ENV_VAR,
  AI_PROVIDER_ENV_VAR,
];
const saved: Record<string, string | undefined> = {};
for (const name of ['APP_ENV', 'NODE_ENV', ...FACTORY_VARS]) saved[name] = env[name];

const FACTORIES: Array<{ owner: string; select: () => void; resolve: () => unknown }> = [
  { owner: 'spec 021 payments', select: () => (env[PAYMENT_PROVIDER_ENV_VAR] = 'sandbox'), resolve: resolvePaymentProvider },
  { owner: 'spec 024 payouts', select: () => (env[PAYOUT_PROVIDER_ENV_VAR] = 'sandbox'), resolve: resolvePayoutProvider },
  {
    owner: 'spec 026 notification channels',
    select: () => (env[NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR] = 'sandbox'),
    resolve: resolveNotificationChannelAdapters,
  },
  {
    owner: 'spec 027 file storage',
    select: () => (env[FILE_STORAGE_PROVIDER_ENV_VAR] = LOCAL_STORAGE_ADAPTER_NAME),
    resolve: resolveFileStorageAdapter,
  },
  { owner: 'spec 027 file scanning', select: () => (env[FILE_SCANNER_ENV_VAR] = SANDBOX_SCANNER_NAME), resolve: resolveFileScanner },
  { owner: 'spec 033 AI', select: () => (env[AI_PROVIDER_ENV_VAR] = 'sandbox'), resolve: resolveAiProvider },
];

describe('DEP-1: sandbox adapters refuse only a production deployment (APP_ENV)', () => {
  useTemporaryStorageDir();

  beforeEach(() => {
    env.NODE_ENV = 'production';
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  });

  describe('isProductionDeployment (spec 041)', () => {
    it('is true for APP_ENV=production', () => {
      env.APP_ENV = 'production';
      expect(isProductionDeployment()).toBe(true);
    });

    it('is true when APP_ENV is unset under NODE_ENV=production, so existing production deployments are unchanged', () => {
      delete env.APP_ENV;
      expect(isProductionDeployment()).toBe(true);
      env.APP_ENV = '';
      expect(isProductionDeployment()).toBe(true);
    });

    it('fails closed: an invalid APP_ENV counts as production', () => {
      env.APP_ENV = 'prod';
      expect(isProductionDeployment()).toBe(true);
    });

    it('is false for APP_ENV=staging and APP_ENV=development, even under NODE_ENV=production', () => {
      for (const value of ['staging', 'development']) {
        env.APP_ENV = value;
        expect(isProductionDeployment(), value).toBe(false);
      }
    });

    it('is false for a local run with APP_ENV unset and NODE_ENV other than production', () => {
      delete env.APP_ENV;
      env.NODE_ENV = 'development';
      expect(isProductionDeployment()).toBe(false);
    });
  });

  for (const factory of FACTORIES) {
    describe(factory.owner, () => {
      it('refuses its sandbox when APP_ENV=production', () => {
        env.APP_ENV = 'production';
        factory.select();
        expect(() => factory.resolve()).toThrow(/must never run in production/);
      });

      it('refuses its sandbox when APP_ENV is unset under NODE_ENV=production', () => {
        delete env.APP_ENV;
        factory.select();
        expect(() => factory.resolve()).toThrow(/must never run in production/);
      });

      it('refuses its sandbox when APP_ENV is invalid (fails closed)', () => {
        env.APP_ENV = 'prod';
        factory.select();
        expect(() => factory.resolve()).toThrow(/must never run in production/);
      });

      it('runs its sandbox on a hosted staging or demo deployment (APP_ENV=staging, NODE_ENV=production)', () => {
        env.APP_ENV = 'staging';
        factory.select();
        expect(factory.resolve()).toBeTruthy();
      });
    });
  }
});
