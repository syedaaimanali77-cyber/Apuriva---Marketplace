/**
 * Spec 027 §3 "Signed URLs …" (AC-2, AC-3, AC-6) — issuing a URL, and serving the bytes behind one.
 *
 * The rule that makes a leaked or stale link worthless: **a signature is never an authorization.**
 * `GET /files/{id}` re-resolves authorization before issuing, and `GET /files/{id}/content`
 * re-resolves it again on EVERY fetch, in this order:
 *
 *   verify the signature and that it is unexpired
 *     -> load the asset (soft-deleted reads as absent)
 *     -> refuse unless `status = 'ready'`
 *     -> re-run the context policy's `canRead` for the BOUND user id
 *
 * So: a link that leaks to another user fails (it is bound to the original user); an expired link
 * fails; and a link held by a user whose access was since revoked — conversation archived, request
 * deleted, admin role removed — stops working at the very next fetch.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { SessionRow } from '@/lib/auth/session';
import type { ActiveMode } from '@/lib/types/users';
import type { FileUrlDto } from '@/lib/types/files';
import { findLiveAsset, type FileAssetRow } from './assets';
import { adapterOrThrow } from './adapter';
import { signedUrlTtlSeconds } from './config';
import { getFileContextPolicy } from './contexts/registry';
import { fileNotFoundError, fileNotReadyError, fileRejectedError } from './errors';
import { resolveImageOptimizer } from './optimization';
import { verifyContentSignature } from './storage';
import { isUuid, queryRows } from './sql';

/**
 * Loads an asset the caller may READ, or throws. Every failure mode a caller could use to probe —
 * unknown id, malformed id, soft-deleted, someone else's — is the same `404 FILE_NOT_FOUND` (AC-6).
 * `409 FILE_NOT_READY` / `409 FILE_REJECTED` are only ever reached by someone already authorized.
 */
export async function loadReadableAsset(
  caller: { userId: string; activeMode: ActiveMode },
  fileAssetId: string,
  correlationId: string | null,
): Promise<FileAssetRow> {
  if (!isUuid(fileAssetId)) throw fileNotFoundError();

  const asset = await findLiveAsset(fileAssetId);
  if (!asset) throw fileNotFoundError();

  const policy = getFileContextPolicy(asset.context_type!);
  // A context whose policy is no longer registered is unauthorizable, so nobody may read it —
  // the same fail-closed answer AC-8 gives at upload time.
  if (!policy) throw fileNotFoundError();

  const mayRead = await policy.canRead({
    userId: caller.userId,
    activeMode: caller.activeMode,
    asset,
    correlationId,
  });
  if (!mayRead) throw fileNotFoundError();

  if (asset.status === 'rejected') throw fileRejectedError(asset.rejection_reason ?? 'scan_rejected');
  if (asset.status !== 'ready') throw fileNotReadyError(asset.status);

  return asset;
}

/**
 * AC-2/AC-3. A public asset gets a CDN URL carrying the optimizer's delivery transform and no
 * expiry; a private one gets a signed URL bound to this caller that expires after
 * `FILE_SIGNED_URL_TTL_SECONDS`. There is no third case: no permanently public path to a private
 * object exists, and the adapter exposes no public URL for one.
 */
export async function issueFileUrl(
  session: Pick<SessionRow, 'userId' | 'activeMode'>,
  fileAssetId: string,
  correlationId: string,
): Promise<FileUrlDto> {
  const asset = await loadReadableAsset(session, fileAssetId, correlationId);
  const adapter = adapterOrThrow();

  if (asset.visibility === 'public') {
    const transform = resolveImageOptimizer().deliveryTransform({ mimeType: asset.mime_type ?? '' });
    const url = adapter.publicUrl({ storageKey: asset.storage_key!, transform });
    // No CDN configured means there is no public URL — so the asset is served the private way
    // rather than claiming a delivery path that does not exist.
    if (url !== null) return { url, expiresAt: null, visibility: 'public' };
  }

  const ttlSeconds = signedUrlTtlSeconds();
  const signed = await adapter.createSignedUrl({
    storageKey: asset.storage_key!,
    fileAssetId: asset.id,
    userId: session.userId,
    ttlSeconds,
  });
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString(), visibility: asset.visibility };
}

export interface ContentResponse {
  bytes: Buffer;
  contentType: string;
  fileName: string | null;
}

/**
 * The signed-URL target. `session` is optional by design — a real signed URL stands on its own, the
 * same position spec 008's download route takes — but the SIGNATURE only identifies which user the
 * link was issued to. Authorization is re-resolved for that user here, every time.
 */
export async function serveFileContent(fileAssetId: string, url: URL): Promise<ContentResponse> {
  if (!isUuid(fileAssetId)) throw fileNotFoundError();

  const verified = verifyContentSignature(fileAssetId, url.searchParams);
  // Missing, forged and EXPIRED signatures are all `404` — an expired link is refused outright.
  if (!verified) throw fileNotFoundError();

  const asset = await findLiveAsset(fileAssetId);
  if (!asset || asset.status !== 'ready' || asset.storage_key === null) throw fileNotFoundError();

  const policy = getFileContextPolicy(asset.context_type!);
  if (!policy) throw fileNotFoundError();

  // The re-authorization AC-6 turns on: the bound user's CURRENT access, not the access they had
  // when the link was issued. The caller's active mode is not carried on a signed link, so the
  // asset's own context is resolved in the mode that owns it.
  const mayRead = await policy.canRead({
    userId: verified.userId,
    activeMode: await inferActiveMode(asset, verified.userId),
    asset,
    correlationId: null,
  });
  if (!mayRead) throw fileNotFoundError();

  const bytes = await adapterOrThrow().readAll(asset.storage_key);
  if (bytes === null) throw fileNotFoundError();

  return { bytes, contentType: asset.mime_type ?? 'application/octet-stream', fileName: asset.file_name };
}

/**
 * A signed link carries no session, so there is no active mode to read. For a `message_attachment`
 * — the one context whose rule is mode-scoped (spec 025's) — the mode is derived from which side of
 * the booking the bound user is on, so a valid link works for the party it was issued to without
 * this spec inventing a way to bypass spec 025's rule for the party it was not.
 */
async function inferActiveMode(asset: FileAssetRow, userId: string): Promise<ActiveMode> {
  if (asset.context_type !== 'message_attachment' || asset.context_id === null) return 'customer';
  const [row] = await queryRows<{ is_provider: boolean }>(
    getDb(),
    sql`SELECT (pp.user_id = ${userId}) AS is_provider
          FROM bookings b
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${asset.context_id}`,
  );
  return row?.is_provider ? 'provider' : 'customer';
}
