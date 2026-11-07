import { and, eq } from 'drizzle-orm';
import { ApiRouteError, validationError } from '@/lib/api/errors';
import { ensureCustomerProfile } from '@/lib/auth/profiles';
import { getDb } from '@/lib/db';
import { customerProfiles, providerProfiles, users } from '@/lib/db/schema';
import type { ProviderProfileDto, UserProfileDto } from '@/lib/types/profile';

/**
 * Account → Profile. The customer's display name (`customer_profiles.display_name`) and the provider's
 * business name (`provider_profiles.business_name`) — both columns that already exist — plus the account's
 * email and phone, read-only.
 *
 * Name rules: any script (Urdu and Roman Urdu included), surrounding whitespace trimmed, no control
 * characters, at most 60 characters (the trimmed string's length, as every other text limit in this
 * repository and the input's `maxLength` count). An empty name clears it. A business name is published
 * immediately; spec 038 moderates provider profiles after publication.
 *
 * Writes are optimistic-concurrency guarded: `expectedVersion` must match the row's `version`, otherwise
 * `409 CONFLICT`.
 */
export const PROFILE_NAME_MAX_LENGTH = 60;

// Control characters (Unicode category Cc). Format characters (Cf) are allowed: Urdu text legitimately uses
// the zero-width non-joiner.
const CONTROL_CHARACTER = /\p{Cc}/u;

/** The stored form of a submitted name: trimmed text, or `null` to clear. Throws `400` when invalid. */
export function normalizeProfileName(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw validationError([{ field, message: 'must be a string or null' }]);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (CONTROL_CHARACTER.test(trimmed)) throw validationError([{ field, message: 'must not contain control characters' }]);
  if (trimmed.length > PROFILE_NAME_MAX_LENGTH) {
    throw validationError([{ field, message: `must be at most ${PROFILE_NAME_MAX_LENGTH} characters` }]);
  }
  return trimmed;
}

/** `expectedVersion` is required on every profile write. */
export function requireExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError([{ field: 'expectedVersion', message: 'must be the profile version you last read' }]);
  }
  return value;
}

/** Like the other account settings routes, a body carrying any field besides the ones named is refused. */
function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw validationError(unknown.map((field) => ({ field, message: 'is not a recognised field' })));
}

function staleVersionError(): ApiRouteError {
  return new ApiRouteError('CONFLICT', 'Your profile was changed elsewhere. Reload it and try again.');
}

export async function getUserProfile(userId: string): Promise<UserProfileDto> {
  // Spec 006: every user is a customer; the row is provisioned at login, ensured here defensively.
  await ensureCustomerProfile(userId);
  const [row] = await getDb()
    .select({
      displayName: customerProfiles.displayName,
      version: customerProfiles.version,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      phoneNumber: users.phoneNumber,
      phoneVerifiedAt: users.phoneVerifiedAt,
    })
    .from(customerProfiles)
    .innerJoin(users, eq(users.id, customerProfiles.userId))
    .where(eq(customerProfiles.userId, userId));
  return {
    displayName: row!.displayName,
    email: row!.email,
    emailVerified: row!.emailVerifiedAt !== null,
    phoneNumber: row!.phoneNumber,
    phoneVerified: row!.phoneVerifiedAt !== null,
    version: row!.version,
  };
}

export async function updateUserDisplayName(userId: string, body: Record<string, unknown>): Promise<UserProfileDto> {
  rejectUnknownFields(body, ['displayName', 'expectedVersion']);
  if (!('displayName' in body)) throw validationError([{ field: 'displayName', message: 'is required (a string, or null to clear)' }]);
  const displayName = normalizeProfileName(body.displayName, 'displayName');
  const expectedVersion = requireExpectedVersion(body.expectedVersion);
  await ensureCustomerProfile(userId);

  const [updated] = await getDb()
    .update(customerProfiles)
    .set({ displayName, version: expectedVersion + 1, updatedAt: new Date() })
    .where(and(eq(customerProfiles.userId, userId), eq(customerProfiles.version, expectedVersion)))
    .returning({ id: customerProfiles.id });
  if (!updated) throw staleVersionError();
  return getUserProfile(userId);
}

async function providerRow(userId: string) {
  const [row] = await getDb()
    .select({ businessName: providerProfiles.businessName, version: providerProfiles.version })
    .from(providerProfiles)
    .where(eq(providerProfiles.userId, userId));
  // Provider mode can only be selected once a provider profile exists (spec 006 §4); guard anyway.
  if (!row) throw new ApiRouteError('NOT_FOUND', 'No provider profile exists for this account.');
  return row;
}

export async function getProviderProfile(userId: string): Promise<ProviderProfileDto> {
  return providerRow(userId);
}

export async function updateProviderBusinessName(userId: string, body: Record<string, unknown>): Promise<ProviderProfileDto> {
  rejectUnknownFields(body, ['businessName', 'expectedVersion']);
  if (!('businessName' in body)) throw validationError([{ field: 'businessName', message: 'is required (a string, or null to clear)' }]);
  const businessName = normalizeProfileName(body.businessName, 'businessName');
  const expectedVersion = requireExpectedVersion(body.expectedVersion);
  await providerRow(userId);

  const [updated] = await getDb()
    .update(providerProfiles)
    .set({ businessName, version: expectedVersion + 1, updatedAt: new Date() })
    .where(and(eq(providerProfiles.userId, userId), eq(providerProfiles.version, expectedVersion)))
    .returning({ businessName: providerProfiles.businessName, version: providerProfiles.version });
  if (!updated) throw staleVersionError();
  return updated;
}
