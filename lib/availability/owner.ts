/**
 * Spec 016 §3 — the ownership resolution every `/providers/me/**` route shares.
 *
 * These routes never accept a provider id from the client: the profile is looked up by the
 * session user, so there is no IDOR surface on them at all. A session user with no provider
 * profile is `404 NOT_FOUND`, per §3's error table.
 */
import { providerProfileNotFoundError } from './errors';
import { findProviderProfileForUser, type ProviderSchedulingProfile } from './repository';

export async function requireOwnProviderProfile(userId: string): Promise<ProviderSchedulingProfile> {
  const profile = await findProviderProfileForUser(userId);
  if (!profile) throw providerProfileNotFoundError();
  return profile;
}

/** Parses `?from=&to=` for the overrides and slots reads. */
export const MAX_RANGE_DAYS = 62;
