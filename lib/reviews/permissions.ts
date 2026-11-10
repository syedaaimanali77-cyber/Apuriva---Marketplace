/**
 * Spec 029 §3 "Who moderates" (AC-9) — the admin permission boundary for reviews.
 *
 * `('reviews','read_moderation_queue')` and `('reviews','moderate')` are seeded by
 * `drizzle/0026_add_reviews_ratings.sql` for exactly two roles: Trust & Safety and Super Admin.
 * Master §69 scopes Content/Marketplace Admin to services, categories and FAQs, so a review — a
 * trust matter — is not theirs; every other admin role therefore cannot see or resolve one.
 *
 * `medium` per master §70 is "authorized admin + reason/audit": one authorized admin, a reason, an
 * audit record. No `AdminAction` row and no four-eyes framework — the same call spec 023 made for
 * `no_show_reports/resolve`, and for the same reason: the admin picks an outcome from a closed set,
 * never an amount.
 *
 * Resolution is always server-side (spec 009 §5). The frontend may hide a link but is never
 * authoritative.
 */
import { forbiddenError } from '@/lib/api/errors';
import { resolvePermission } from '@/lib/admin-rbac/permissions';

export const REVIEWS_RESOURCE = 'reviews';
export const REVIEWS_READ_QUEUE_ACTION = 'read_moderation_queue';
export const REVIEWS_MODERATE_ACTION = 'moderate';

export async function requireReviewQueuePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, REVIEWS_RESOURCE, REVIEWS_READ_QUEUE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to view the review moderation queue.');
}

export async function requireReviewModeratePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, REVIEWS_RESOURCE, REVIEWS_MODERATE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to moderate reviews.');
}
