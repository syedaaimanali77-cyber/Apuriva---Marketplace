/**
 * Spec 029 §3 "Media" — the resolver that lifts spec 027's `review_media` context out of
 * `422 FILE_CONTEXT_NOT_AVAILABLE`.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/files/contexts/`. Spec 027 §3 makes the consuming spec the
 * owner of "who may see a file in a given context", and `lib/files/boundaries.test.ts` enforces
 * that `lib/files/**` never acquires a consuming spec's business rules. Who may attach a photo to a
 * review, and who may then look at it, is a SPEC 029 rule — so it is written here, in this spec's
 * own domain, and handed to spec 027's registry from the composition root. Spec 027's source is not
 * touched at all; the only change to it anywhere is one new value in a closed vocabulary.
 *
 * `contextId` is the BOOKING id, not the review id: media is chosen before the review exists, which
 * is spec 027's own stated reasoning for `message_attachment`, verbatim.
 *
 * The two rules, and why each is what it is:
 *
 *   UPLOAD — the booking's own customer, in customer mode, and only while that booking has actually
 *   reached `completed` AND the review window is still open. So a photo cannot be pre-staged before
 *   the job ends, and cannot be bolted on months later. Because this is the ONLY way a
 *   `review_media` row can come into existence, `create.ts` can trust its own rows.
 *
 *   READ — a `ready`, `public` asset whose owning review is VISIBLE is readable by anyone, including
 *   guests: that is what "a review is public content" means. Anything else is readable only by the
 *   uploader, or by an admin holding `reviews/moderate` — and that admin read is AUDITED before the
 *   URL is issued, the pattern spec 025's `messageAttachmentPolicy` established.
 *
 * THE RULE THAT MAKES AC-8 REAL: the read consults the OWNING REVIEW'S STATUS. Removing a review
 * therefore removes its photographs from public view in the same act, with no cascade, no sweep and
 * no second decision — and because spec 027 re-runs `canRead` on every URL issue and every content
 * fetch, an already-issued link stops working too.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import { queryRows } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import { registerFileContextPolicy, type FileContextPolicy } from '@/lib/files/contexts/registry';
import type { FileAssetRow } from '@/lib/files/assets';
import { MAX_REVIEW_MEDIA, REVIEW_MEDIA_CONTEXT, reviewWindowDays } from './limits';
import { REVIEWS_MODERATE_ACTION, REVIEWS_RESOURCE } from './permissions';

/**
 * Whether `userId` is this booking's customer AND the booking is inside its review window.
 *
 * Deliberately the same completion-history predicate `eligibility.ts` uses — the upload window and
 * the submission window are the same window, and naming the rule twice is what would let them drift.
 */
async function mayAttachToBooking(userId: string, bookingId: string): Promise<boolean> {
  if (!isUuid(bookingId)) return false;
  const rows = await queryRows<{ ok: boolean }>(
    getDb(),
    sql`SELECT (
           (SELECT min(h.occurred_at) FROM bookings_status_history h
             WHERE h.booking_id = b.id AND h.to_status = 'completed')
           + (${reviewWindowDays()} * interval '1 day')
         ) > clock_timestamp() AS ok
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
         WHERE b.id = ${bookingId} AND cp.user_id = ${userId}`,
  );
  // `ok` is NULL when the booking never completed — which is not "may attach".
  return rows[0]?.ok === true;
}

/** Whether the asset's owning review is currently visible to the public. */
async function assetBelongsToVisibleReview(fileAssetId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT r.id FROM review_media rm
          JOIN reviews r ON r.id = rm.review_id
         WHERE rm.file_asset_id = ${fileAssetId} AND r.status IN ('published','flagged')`,
  );
  return rows.length > 0;
}

/**
 * Trust & Safety access, for judging a reported photo. Audited through spec 009's helper BEFORE the
 * URL is issued — if the audit write fails, the read fails and nothing is disclosed.
 */
async function adminMayRead(adminUserId: string, asset: FileAssetRow, correlationId: string | null): Promise<boolean> {
  const permission = await resolvePermission(adminUserId, REVIEWS_RESOURCE, REVIEWS_MODERATE_ACTION);
  if (!permission.allowed) return false;

  await recordAdminAuditEvent({
    actorUserId: adminUserId,
    actorRoles: await getAdminRoleNames(adminUserId),
    eventType: 'reviews.read_review_media',
    resource: REVIEWS_RESOURCE,
    action: REVIEWS_MODERATE_ACTION,
    targetType: 'file_asset',
    targetId: asset.id,
    reason: 'Trust & Safety access to a review photo for moderation.',
    approvalChain: [],
    correlationId,
  });
  return true;
}

export const reviewMediaPolicy: FileContextPolicy = {
  /**
   * The second public-eligible context, after `portfolio`. A review is public content and private
   * media would be invisible to every reader, making the capability pointless.
   */
  publicEligible: true,
  maxPerContext: MAX_REVIEW_MEDIA,
  /**
   * Images only — deliberately narrower than `booking_evidence`, which allows video and documents.
   * Video and documents on a permanently public surface widen the disclosure and moderation surface
   * for no reviewer benefit.
   */
  allowedKinds: ['image'],

  async canUpload({ userId, activeMode, contextId }) {
    if (activeMode !== 'customer') return false;
    if (!contextId) return false;
    return mayAttachToBooking(userId, contextId);
  },

  async canRead({ userId, asset, correlationId }) {
    // Public, scanned-clean, and attached to a review a reader may see.
    if (asset.visibility === 'public' && asset.status === 'ready' && (await assetBelongsToVisibleReview(asset.id))) {
      return true;
    }
    // The uploader always sees their own photo — including before it is attached to any review,
    // which is the whole window in which they are composing one.
    if (asset.uploaded_by_user_id === userId) return true;
    return adminMayRead(userId, asset, correlationId ?? null);
  },
};

/** Called from `instrumentation.ts` — the composition root specs 021–028 already use. */
export function registerReviewMediaContext(): void {
  registerFileContextPolicy(REVIEW_MEDIA_CONTEXT, reviewMediaPolicy);
}
