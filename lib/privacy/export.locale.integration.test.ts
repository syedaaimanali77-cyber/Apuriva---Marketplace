import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { sweepDeletions } from './deletion';
import { generateExportPayload } from './export';
import { seedUser } from './test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 042 §4 "Retention and privacy" (X-5, D-12, AC-7). */
describe.skipIf(!dbReachable)('users.locale in the spec 008 export and deletion (spec 042 §4)', () => {
  it("the export's account section carries the saved locale", async () => {
    const userId = await seedUser();
    await getDb().update(users).set({ locale: 'ur' }).where(eq(users.id, userId));
    const payload = await generateExportPayload(userId);
    expect(payload.profile.locale).toBe('ur');
  });

  it('a never-chosen locale exports as null', async () => {
    const userId = await seedUser();
    const payload = await generateExportPayload(userId);
    expect(payload.profile).toHaveProperty('locale', null);
  });

  it('the deletion sweep nulls it in the same anonymization update as email and phone', async () => {
    const userId = await seedUser();
    await getDb()
      .update(users)
      .set({ locale: 'ur', lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, userId));
    await sweepDeletions();
    const [row] = await getDb()
      .select({ locale: users.locale, lifecycleStatus: users.lifecycleStatus, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    expect(row).toEqual({ locale: null, lifecycleStatus: 'deleted', email: null });
  });
});
