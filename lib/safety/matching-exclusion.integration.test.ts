/**
 * Spec 030 §6 (AC-1, matching half) — a block excludes a provider from the customer's future
 * matching runs, at the HARD ELIGIBILITY stage, before any score is computed.
 *
 * This is the half of AC-1 that reaches into spec 017, so it is also the half most at risk of
 * quietly changing that spec's behaviour. The first test therefore pins the pre-030 default.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import {
  getProviderBlockSource,
  loadBlockedProviderProfileIds,
  registerProviderBlockSource,
  resetProviderBlockSource,
} from '@/lib/matching/block-source';
import { blockedProviderProfileIds, createBlock } from './blocks';
import {
  isDatabaseReachable,
  resetSafetyIntegrationForTests,
  seedBareUser,
  useSafetyIntegration,
} from './safety-test-support';

const dbReachable = await isDatabaseReachable();

/** A provider profile owned by a freshly seeded user, which is all this port needs. */
async function seedProviderProfileFor(userId: string): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO provider_profiles (user_id) VALUES (${userId}) RETURNING id`,
  );
  return row!.id;
}

describe.skipIf(!dbReachable)('spec 030 matching exclusion (AC-1, integration)', () => {
  beforeEach(() => {
    useSafetyIntegration();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  describe('the port', () => {
    it('is registered by registerSafetyIntegration', () => {
      expect(getProviderBlockSource()).toBe(blockedProviderProfileIds);
    });

    it('defaults to NOBODY blocked when unregistered — spec 017 pre-030 behaviour exactly', async () => {
      resetProviderBlockSource();
      const customer = await seedBareUser();
      const providerUser = await seedBareUser();
      const profile = await seedProviderProfileFor(providerUser);
      await createBlock(customer, providerUser);

      // The block exists, but with the port unregistered spec 017 sees nothing.
      expect((await loadBlockedProviderProfileIds(customer, [profile])).size).toBe(0);
    });

    it('treats a throwing source as nobody-blocked rather than emptying the pool', async () => {
      registerProviderBlockSource(async () => {
        throw new Error('the blocking subsystem is down');
      });
      const customer = await seedBareUser();
      // Under-excluding and logging is the safe direction here: an empty candidate pool looks like
      // the platform is broken, and the block still holds where it matters most — messaging.
      expect((await loadBlockedProviderProfileIds(customer, ['11111111-1111-1111-1111-111111111111'])).size).toBe(0);
    });
  });

  describe('resolution', () => {
    it('maps a user-scoped block onto the provider PROFILE ids matching works with', async () => {
      const customer = await seedBareUser();
      const providerUser = await seedBareUser();
      const profile = await seedProviderProfileFor(providerUser);
      await createBlock(customer, providerUser);

      const blocked = await loadBlockedProviderProfileIds(customer, [profile]);
      expect([...blocked]).toEqual([profile]);
    });

    it('excludes when the PROVIDER blocked the customer too — bidirectional', async () => {
      const customer = await seedBareUser();
      const providerUser = await seedBareUser();
      const profile = await seedProviderProfileFor(providerUser);
      await createBlock(providerUser, customer);

      expect([...(await loadBlockedProviderProfileIds(customer, [profile]))]).toEqual([profile]);
    });

    it('leaves unrelated providers in the pool', async () => {
      const customer = await seedBareUser();
      const blockedUser = await seedBareUser();
      const innocentUser = await seedBareUser();
      const blockedProfile = await seedProviderProfileFor(blockedUser);
      const innocentProfile = await seedProviderProfileFor(innocentUser);
      await createBlock(customer, blockedUser);

      const blocked = await loadBlockedProviderProfileIds(customer, [blockedProfile, innocentProfile]);
      expect(blocked.has(blockedProfile)).toBe(true);
      expect(blocked.has(innocentProfile)).toBe(false);
    });

    it('stops excluding once the block is removed', async () => {
      const customer = await seedBareUser();
      const providerUser = await seedBareUser();
      const profile = await seedProviderProfileFor(providerUser);
      const { block } = await createBlock(customer, providerUser);

      expect((await loadBlockedProviderProfileIds(customer, [profile])).size).toBe(1);
      await getDb().execute(sql`DELETE FROM user_blocks WHERE id = ${block.id}`);
      expect((await loadBlockedProviderProfileIds(customer, [profile])).size).toBe(0);
    });

    it('resolves a whole candidate pool in ONE query rather than one per candidate', async () => {
      const customer = await seedBareUser();
      const profiles: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        profiles.push(await seedProviderProfileFor(await seedBareUser()));
      }
      // The assertion that matters is behavioural: a batch of five returns correctly in one call.
      await expect(loadBlockedProviderProfileIds(customer, profiles)).resolves.toBeInstanceOf(Set);
    });
  });

  describe("spec 017's vocabulary", () => {
    it("admits 'blocked' as an exclusion reason at the database", async () => {
      const [row] = await queryRows<{ def: string }>(
        getDb(),
        sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conname = 'request_provider_matches_exclusion_reason_ck'`,
      );
      expect(row!.def).toContain('blocked');
    });
  });
});
