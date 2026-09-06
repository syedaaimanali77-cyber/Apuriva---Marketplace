import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  bookings,
  conversationParticipants,
  customerProfiles,
  fileAssets,
  messages,
  notificationPreferences,
  offers,
  payments,
  providerProfiles,
  refunds,
  requests,
  reviews,
  users,
} from '@/lib/db/schema';
import type { DataExportStatusDto } from '@/lib/types/privacy';
import { buildDownloadUrl, verifyDownloadToken } from './download-token';
import { getFileAssetStorage } from './file-asset-storage';
import { NOT_FOUND_ERROR } from './not-found';

export interface DataExportPayload {
  generatedAt: string;
  profile: {
    id: string;
    email: string | null;
    phoneNumber: string | null;
    createdAt: string;
    customerProfile: { id: string; createdAt: string } | null;
    providerProfile: { id: string; businessName: string | null; lifecycleStatus: string; createdAt: string } | null;
  };
  bookings: Array<{ id: string; status: string; createdAt: string }>;
  reviews: Array<{ id: string; bookingId: string; createdAt: string }>;
  /** "Permitted messages" (spec 008 §3): messages in a conversation `userId` participates in —
   * the same participant boundary spec 025 uses to authorize a messaging read, never a broader
   * query (e.g. never all messages the user merely sent, if they'd since left the conversation). */
  messages: Array<{ id: string; conversationId: string; senderUserId: string; createdAt: string }>;
  preferences: { id: string; createdAt: string } | null;
  receipts: {
    payments: Array<{ id: string; bookingId: string; status: string; createdAt: string }>;
    refunds: Array<{ id: string; paymentId: string; createdAt: string }>;
  };
}

/**
 * Every entity here is fetched with an explicit column allowlist and an ownership-scoped join —
 * never `select *` — so a future spec adding an internal-only column (fraud/ranking signal,
 * moderation note) to one of these tables doesn't silently start flowing into an export just
 * because it exists on the row. Only entities/columns already implemented are included; there is
 * nothing yet to accidentally leak from specs not yet built (payments/reviews/etc. are still
 * their spec-003 baseline shape).
 */
export async function generateExportPayload(userId: string): Promise<DataExportPayload> {
  const db = getDb();

  const [user] = await db
    .select({ id: users.id, email: users.email, phoneNumber: users.phoneNumber, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw NOT_FOUND_ERROR();

  const [customerProfile] = await db
    .select({ id: customerProfiles.id, createdAt: customerProfiles.createdAt })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));

  const [providerProfile] = await db
    .select({
      id: providerProfiles.id,
      businessName: providerProfiles.businessName,
      lifecycleStatus: providerProfiles.lifecycleStatus,
      createdAt: providerProfiles.createdAt,
    })
    .from(providerProfiles)
    .where(eq(providerProfiles.userId, userId));

  const bookingRows = await db
    .select({ id: bookings.id, status: bookings.status, createdAt: bookings.createdAt })
    .from(bookings)
    .innerJoin(offers, eq(offers.id, bookings.offerId))
    .innerJoin(requests, eq(requests.id, offers.requestId))
    .innerJoin(customerProfiles, eq(customerProfiles.id, requests.customerProfileId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, offers.providerProfileId))
    .where(or(eq(customerProfiles.userId, userId), eq(providerProfiles.userId, userId)));

  const reviewRows = await db
    .select({ id: reviews.id, bookingId: reviews.bookingId, createdAt: reviews.createdAt })
    .from(reviews)
    .where(eq(reviews.authorUserId, userId));

  const messageRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderUserId: messages.senderUserId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(
      conversationParticipants,
      and(eq(conversationParticipants.conversationId, messages.conversationId), eq(conversationParticipants.userId, userId)),
    );

  const [preferences] = await db
    .select({ id: notificationPreferences.id, createdAt: notificationPreferences.createdAt })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  const paymentRows = await db
    .select({ id: payments.id, bookingId: payments.bookingId, status: payments.status, createdAt: payments.createdAt })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .innerJoin(offers, eq(offers.id, bookings.offerId))
    .innerJoin(requests, eq(requests.id, offers.requestId))
    .innerJoin(customerProfiles, eq(customerProfiles.id, requests.customerProfileId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, offers.providerProfileId))
    .where(or(eq(customerProfiles.userId, userId), eq(providerProfiles.userId, userId)));

  const paymentIds = paymentRows.map((p) => p.id);
  const refundRows = paymentIds.length
    ? await db
        .select({ id: refunds.id, paymentId: refunds.paymentId, createdAt: refunds.createdAt })
        .from(refunds)
        .where(inArray(refunds.paymentId, paymentIds))
    : [];

  return {
    generatedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      createdAt: user.createdAt.toISOString(),
      customerProfile: customerProfile ? { id: customerProfile.id, createdAt: customerProfile.createdAt.toISOString() } : null,
      providerProfile: providerProfile
        ? {
            id: providerProfile.id,
            businessName: providerProfile.businessName,
            lifecycleStatus: providerProfile.lifecycleStatus,
            createdAt: providerProfile.createdAt.toISOString(),
          }
        : null,
    },
    bookings: bookingRows.map((b) => ({ id: b.id, status: b.status, createdAt: b.createdAt.toISOString() })),
    reviews: reviewRows.map((r) => ({ id: r.id, bookingId: r.bookingId, createdAt: r.createdAt.toISOString() })),
    messages: messageRows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    preferences: preferences ? { id: preferences.id, createdAt: preferences.createdAt.toISOString() } : null,
    receipts: {
      payments: paymentRows.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      refunds: refundRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    },
  };
}

/** `POST /users/me/data-export` (AC-3) — idempotent while non-terminal: a pending/processing
 * export already in flight for this user returns that same id instead of starting a duplicate. */
export async function requestExport(userId: string): Promise<{ exportRequestId: string }> {
  const db = getDb();
  const [user] = await db
    .select({ dataExportRequestId: users.dataExportRequestId, dataExportStatus: users.dataExportStatus })
    .from(users)
    .where(eq(users.id, userId));

  if (user?.dataExportRequestId && (user.dataExportStatus === 'pending' || user.dataExportStatus === 'processing')) {
    return { exportRequestId: user.dataExportRequestId };
  }

  const exportRequestId = randomUUID();
  await db
    .update(users)
    .set({ dataExportRequestId: exportRequestId, dataExportStatus: 'pending', dataExportFileAssetId: null })
    .where(eq(users.id, userId));
  return { exportRequestId };
}

/** `GET /users/me/data-export/{id}` — `id` must belong to the caller; otherwise (including a
 * nonexistent id) throws the same `NOT_FOUND` as any other id that isn't this user's. */
export async function getExportStatusDto(userId: string, exportRequestId: string): Promise<DataExportStatusDto> {
  const db = getDb();
  const [user] = await db
    .select({
      dataExportRequestId: users.dataExportRequestId,
      dataExportStatus: users.dataExportStatus,
      dataExportFileAssetId: users.dataExportFileAssetId,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user || user.dataExportRequestId !== exportRequestId || !user.dataExportStatus) throw NOT_FOUND_ERROR();

  if (user.dataExportStatus !== 'ready' || !user.dataExportFileAssetId) {
    return { status: user.dataExportStatus };
  }

  const { url, expiresAt } = buildDownloadUrl(exportRequestId);
  return { status: 'ready', downloadUrl: url, expiresAt: expiresAt.toISOString() };
}

export interface ExportDownload {
  filename: string;
  contentType: string;
  body: string;
}

/** Backs `GET /users/me/data-export/{id}/download` — a real signed URL, verified purely by
 * signature + expiry (no session required), scoped to the one user it was issued for. */
export async function getExportDownload(
  exportRequestId: string,
  expiresAtMsRaw: string | null,
  sig: string | null,
): Promise<ExportDownload> {
  if (!verifyDownloadToken(exportRequestId, expiresAtMsRaw, sig)) throw NOT_FOUND_ERROR();

  const db = getDb();
  const [user] = await db
    .select({ dataExportStatus: users.dataExportStatus, dataExportFileAssetId: users.dataExportFileAssetId })
    .from(users)
    .where(eq(users.dataExportRequestId, exportRequestId));
  if (!user || user.dataExportStatus !== 'ready' || !user.dataExportFileAssetId) throw NOT_FOUND_ERROR();

  const payload = await getFileAssetStorage().retrieve(user.dataExportFileAssetId);
  if (!payload) throw NOT_FOUND_ERROR();

  return { filename: 'apuriva-data-export.json', contentType: 'application/json', body: payload };
}

/**
 * Scheduled sweep (`app/api/v1/cron/data-export-sweep`) — server-side, asynchronous generation;
 * never depends on the requester's browser staying open. Idempotent/retry-safe: only
 * pending/processing rows are selected, and a crash after marking a row `processing` just means
 * the next run retries generation for that same row (the eventual `ready`/`failed` write is what
 * ends the loop, so re-running mid-way never produces duplicate file_assets — each user has at
 * most one referenced by `data_export_file_asset_id` at a time).
 *
 * The `file_assets` row inserted here is a bare reference (spec 008's data model: "adds no
 * storage fields of its own beyond referencing a FileAsset per export") — the generated content
 * itself is handed to spec 027's storage capability (lib/privacy/file-asset-storage.ts), never a
 * spec-008-invented column or storage backend of its own. If no implementation of that capability
 * is registered (spec 027 isn't built yet), `store` throws, this loop's catch below marks the
 * export `failed`, and the real cause is logged — export generation is honestly blocked on that
 * dependency rather than silently faked via a parallel storage mechanism.
 */
export async function runExportSweep(): Promise<{ processed: number }> {
  const db = getDb();
  const due = await db.select({ id: users.id }).from(users).where(inArray(users.dataExportStatus, ['pending', 'processing']));

  let processed = 0;
  for (const { id } of due) {
    try {
      await db.update(users).set({ dataExportStatus: 'processing' }).where(eq(users.id, id));
      const payload = await generateExportPayload(id);
      const [asset] = await db.insert(fileAssets).values({ uploadedByUserId: id }).returning({ id: fileAssets.id });
      await getFileAssetStorage().store(asset!.id, JSON.stringify(payload));
      await db.update(users).set({ dataExportStatus: 'ready', dataExportFileAssetId: asset!.id }).where(eq(users.id, id));
      processed += 1;
    } catch (err) {
      console.error(JSON.stringify({ event: 'privacy.data_export_sweep_failed', userId: id, error: String(err) }));
      await db.update(users).set({ dataExportStatus: 'failed' }).where(eq(users.id, id));
    }
  }
  return { processed };
}
