/**
 * Spec 027 §3 "Context authorization" — the three policies that ship here, and only those.
 *
 * Each one DELEGATES to the rule its owning spec already shipped rather than restating it:
 *   - `request_attachment` → spec 015's owned-request rule (`requests.customer_profile_id` →
 *     `customer_profiles.user_id`), read-only;
 *   - `message_attachment` → spec 025's `resolveConversationAccess`, reused not re-implemented, so
 *     its participant rule, its wrong-active-mode `403` and its archived-conversation rule all stay
 *     spec 025's to change;
 *   - `portfolio` → the uploader's own `provider_profiles` row.
 *
 * `data_export` is registered with a policy that refuses everything: spec 008's artifact rows are
 * already invisible to `findLiveAsset`, and this makes the refusal explicit rather than incidental.
 * `booking_evidence`, `dispute_evidence` and `verification_document` are deliberately NOT registered
 * (AC-8) — 028/029/031 register them when they ship.
 */
import { sql } from 'drizzle-orm';
import { ApiRouteError } from '@/lib/api/errors';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import { getDb } from '@/lib/db';
import { resolveConversationAccess } from '@/lib/messaging/conversations';
import type { FileAssetRow } from '../assets';
import { queryRows, isUuid } from '../sql';
import { registerFileContextPolicy, type FileContextPolicy } from './registry';

/** §3 "Limits" — the per-context count caps. This resolves spec 015 §8 #1 without editing spec 015. */
export const MAX_REQUEST_ATTACHMENTS = 5;
export const MAX_MESSAGE_ATTACHMENTS = 5;
export const MAX_PORTFOLIO_ASSETS = 20;

async function ownsRequest(userId: string, requestId: string | null): Promise<boolean> {
  if (!requestId || !isUuid(requestId)) return false;
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT r.id FROM requests r
          JOIN customer_profiles cp ON cp.id = r.customer_profile_id
         WHERE r.id = ${requestId} AND cp.user_id = ${userId}`,
  );
  return rows.length > 0;
}

/**
 * Spec 015's linkage is the customer's. A provider gains access to a request's attachments only
 * when its owning spec registers that rule here — this spec does not invent one on their behalf.
 */
export const requestAttachmentPolicy: FileContextPolicy = {
  publicEligible: false,
  maxPerContext: MAX_REQUEST_ATTACHMENTS,
  allowedKinds: ['image', 'document'],

  async canUpload({ userId, contextId }) {
    return ownsRequest(userId, contextId);
  },

  async canRead({ userId, asset }) {
    return ownsRequest(userId, asset.context_id);
  },
};

/**
 * `contextId` is the BOOKING id, not a message or conversation id: an attachment is selected before
 * the message that carries it exists, and the booking is what spec 025 resolves participation from.
 * `message_attachments.file_asset_id` links the asset to its message once that message is sent —
 * that linkage is spec 025's to write, and this spec does not write it.
 */
export const messageAttachmentPolicy: FileContextPolicy = {
  publicEligible: false,
  maxPerContext: MAX_MESSAGE_ATTACHMENTS,
  allowedKinds: ['image', 'document'],

  async canUpload({ userId, activeMode, contextId }) {
    if (!contextId || !isUuid(contextId)) return false;
    return participates(userId, activeMode, contextId);
  },

  async canRead({ userId, activeMode, asset, correlationId }) {
    const bookingId = asset.context_id;
    if (!bookingId || !isUuid(bookingId)) return false;
    if (await participates(userId, activeMode, bookingId)) return true;
    return adminMayRead(userId, asset, correlationId ?? null);
  },
};

/**
 * Spec 025's rule verbatim: a participant in their own active mode passes; a participant in the
 * WRONG mode is `403 FORBIDDEN` (rethrown, not swallowed — the caller must see spec 025's answer);
 * a non-participant is simply `false`, which this spec renders as `404` so ids cannot be probed.
 */
async function participates(userId: string, activeMode: 'customer' | 'provider', bookingId: string): Promise<boolean> {
  try {
    await resolveConversationAccess({ userId, activeMode }, bookingId);
    return true;
  } catch (err) {
    if (err instanceof ApiRouteError && err.code === 'FORBIDDEN') throw err;
    return false;
  }
}

/**
 * Spec 025 §3 "Admin and support access": `messaging/read_conversation` (seeded for support, trust
 * & safety and super admin only). Every such read is AUDITED through spec 009's helper before the
 * URL is issued — if the audit write fails, the read fails and nothing is disclosed.
 */
async function adminMayRead(adminUserId: string, asset: FileAssetRow, correlationId: string | null): Promise<boolean> {
  const permission = await resolvePermission(adminUserId, 'messaging', 'read_conversation');
  if (!permission.allowed) return false;

  await recordAdminAuditEvent({
    actorUserId: adminUserId,
    actorRoles: await getAdminRoleNames(adminUserId),
    eventType: 'files.read_message_attachment',
    resource: 'messaging',
    action: 'read_conversation',
    targetType: 'file_asset',
    targetId: asset.id,
    reason: 'Support/trust-and-safety access to a booking conversation attachment.',
    approvalChain: [],
    correlationId,
  });
  return true;
}

async function ownsProviderProfile(userId: string, providerProfileId: string | null): Promise<boolean> {
  if (!providerProfileId || !isUuid(providerProfileId)) return false;
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM provider_profiles WHERE id = ${providerProfileId} AND user_id = ${userId}`,
  );
  return rows.length > 0;
}

/**
 * The one public-eligible context (§8 #7). The portfolio FEATURE — gallery, ordering, display rules
 * — remains its owning spec's; what ships here is the upload/read primitive and an unambiguous
 * owner. A `ready` portfolio asset is readable by anyone, which is what "public" means.
 */
export const portfolioPolicy: FileContextPolicy = {
  publicEligible: true,
  maxPerContext: MAX_PORTFOLIO_ASSETS,
  allowedKinds: ['image', 'video'],

  async canUpload({ userId, contextId }) {
    return ownsProviderProfile(userId, contextId);
  },

  async canRead({ userId, asset }) {
    if (asset.visibility === 'public') return true;
    return ownsProviderProfile(userId, asset.context_id);
  },
};

/** Spec 008's export artifact: never uploadable and never readable through this spec's routes. */
export const dataExportPolicy: FileContextPolicy = {
  publicEligible: false,
  maxPerContext: 0,
  allowedKinds: [],
  async canUpload() {
    return false;
  },
  async canRead() {
    return false;
  },
};

/** Called from `instrumentation.ts` — the composition root, the same place specs 021–026 wire up. */
export function registerShippedFileContextPolicies(): void {
  registerFileContextPolicy('request_attachment', requestAttachmentPolicy);
  registerFileContextPolicy('message_attachment', messageAttachmentPolicy);
  registerFileContextPolicy('portfolio', portfolioPolicy);
  registerFileContextPolicy('data_export', dataExportPolicy);
}
