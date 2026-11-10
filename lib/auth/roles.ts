import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles, customerProfiles, providerProfiles } from '@/lib/db/schema';

/**
 * Spec 005 §4: "Role/Permission ... governed by spec 006 (role model) and 009 (admin RBAC) —
 * this spec only establishes identity and session, not authorization scope." `SessionDto.roles`
 * is populated from what already exists at baseline (spec 003's profile tables) — whether a
 * `CustomerProfile`/`ProviderProfile`/`AdminProfile` row exists for this user — not from any
 * role-assignment logic, which stays out of scope here.
 */
export async function getUserRoles(userId: string): Promise<Array<'customer' | 'provider' | 'admin'>> {
  const db = getDb();
  const [[customer], [provider], [admin]] = await Promise.all([
    db.select({ id: customerProfiles.id }).from(customerProfiles).where(eq(customerProfiles.userId, userId)),
    db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)),
    db.select({ id: adminProfiles.id }).from(adminProfiles).where(eq(adminProfiles.userId, userId)),
  ]);

  const roles: Array<'customer' | 'provider' | 'admin'> = [];
  if (customer) roles.push('customer');
  if (provider) roles.push('provider');
  if (admin) roles.push('admin');
  return roles;
}
