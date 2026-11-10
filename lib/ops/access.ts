/**
 * Spec 046 §3.7 — who may read `GET /api/v1/health/detailed`:
 *   - the ops-health-check monitor, with `Authorization: Bearer <MONITORING_TOKEN>` (compared in
 *     constant time; a configured token shorter than 32 characters authorizes nothing), or
 *   - a Super Admin whose session has completed MFA (spec 005 AC-5) — `getOptionalSession` alone
 *     would also accept an MFA-pending admin session, so that is checked explicitly.
 * Everyone else gets `401 UNAUTHENTICATED`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { getAdminRoleNames } from '@/lib/admin-rbac/permissions';
import { getOptionalSession } from '@/lib/auth/require-session';

export const MONITORING_TOKEN_MIN_LENGTH = 32;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function hasValidMonitoringToken(request: Request, token: string | undefined = process.env.MONITORING_TOKEN): boolean {
  if (!token || token.length < MONITORING_TOKEN_MIN_LENGTH) return false;
  const header = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

export async function canReadDetailedHealth(request: Request): Promise<boolean> {
  if (hasValidMonitoringToken(request)) return true;
  const session = await getOptionalSession(request);
  if (!session || !session.mfaSatisfied) return false;
  return (await getAdminRoleNames(session.userId)).includes('super_admin');
}
