import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles } from '@/lib/db/schema';
import { ApiRouteError } from '@/lib/api/errors';
import type { PersonalizationSettingsDto } from '@/lib/types/home';

/** §2 scope note: personalization is a customer-mode home-feed concept, backed by
 * `CustomerProfile`. A user with no `CustomerProfile` row has nothing this endpoint can read or
 * write — 404, not a fabricated default (unlike `lib/home/feed.ts`'s read-only, never-fails
 * fallback, which serves a page rather than answering a settings request directly). */
function noCustomerProfileError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'No customer profile exists for this account.');
}

/** Spec 014 §3, `GET /api/v1/users/me/personalization-settings`. */
export async function getPersonalizationSettings(userId: string): Promise<PersonalizationSettingsDto> {
  const [row] = await getDb()
    .select({ personalizationEnabled: customerProfiles.personalizationEnabled })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));
  if (!row) throw noCustomerProfileError();
  return { personalizationEnabled: row.personalizationEnabled };
}

/** Spec 014 §3/AC-7, `PATCH /api/v1/users/me/personalization-settings` — opt out/adjust. */
export async function updatePersonalizationSettings(userId: string, personalizationEnabled: boolean): Promise<PersonalizationSettingsDto> {
  const [row] = await getDb()
    .update(customerProfiles)
    .set({ personalizationEnabled })
    .where(eq(customerProfiles.userId, userId))
    .returning({ personalizationEnabled: customerProfiles.personalizationEnabled });
  if (!row) throw noCustomerProfileError();
  return { personalizationEnabled: row.personalizationEnabled };
}
