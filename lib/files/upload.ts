/**
 * Spec 027 §3 "Upload lifecycle" (AC-1, AC-4, AC-5, AC-7, AC-8) — the two server-side steps.
 *
 *   POST /files/upload-url                      POST /files/{id}/finalize
 *      validate DECLARED kind/mime/size            head()       -> ACTUAL size
 *      resolve the context policy (AC-8)           readPrefix() -> magic-byte sniff
 *      derive visibility (never client-supplied)   mismatch/oversize -> rejected + bytes purged
 *      reserve a row: pending + storage_key        clean scan -> ready
 *
 * Nothing a client sends can set `status`, `visibility`, `owner`, `context`, `storage_key` or
 * `size_bytes` (AC-7): the request body is a DECLARATION to be checked, never a value to be stored.
 * Each of those columns is written here from a server-derived value, and migration 0023's
 * `file_assets_terminal_trg` refuses to let a terminal row move even if this code were wrong.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { validationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import type { SessionRow } from '@/lib/auth/session';
import type {
  FileAssetDto,
  FileContextType,
  FileKind,
  FileVisibility,
  UploadTargetDto,
  UploadUrlRequest,
} from '@/lib/types/files';
import { isFileContextType, isFileKind, isFileVisibility } from '@/lib/types/files';
import {
  countContextAssets,
  FILE_ASSET_COLUMNS,
  findLiveAsset,
  logFileEvent,
  toFileAssetDto,
  type FileAssetRow,
} from './assets';
import { uploadUrlTtlSeconds } from './config';
import { getFileContextPolicy } from './contexts/registry';
import {
  fileContextLimitReachedError,
  fileContextNotAvailableError,
  fileNotFoundError,
  fileNotUploadedError,
  fileTypeNotAllowedError,
  idempotencyKeyConflictError,
} from './errors';
import { adapterOrThrow } from './adapter';
import { runScanForAsset } from './scan';
import { queryRows, isUniqueViolation, isUuid } from './sql';
import { MAGIC_BYTE_PREFIX_LENGTH, sanitizeFileName, validateActualObject, validateDeclaredUpload } from './validation';

/** A storage key is ALWAYS server-derived. Nothing a client sends contributes to it. */
function deriveStorageKey(ownerUserId: string, fileAssetId: string): string {
  return `${ownerUserId}/${fileAssetId}`;
}

/** Shape validation only — the allowlist/size checks live in `validateDeclaredUpload`. */
export function parseUploadUrlRequest(body: unknown): UploadUrlRequest {
  const errors: { field: string; message: string }[] = [];
  const input = (body ?? {}) as Record<string, unknown>;

  if (!isFileKind(input.kind)) errors.push({ field: 'kind', message: 'must be image, video or document' });
  if (typeof input.mimeType !== 'string' || input.mimeType.trim() === '') {
    errors.push({ field: 'mimeType', message: 'is required' });
  }
  if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    errors.push({ field: 'sizeBytes', message: 'must be a positive integer' });
  }
  if (typeof input.fileName !== 'string' || input.fileName.trim() === '') {
    errors.push({ field: 'fileName', message: 'is required' });
  }
  if (typeof input.contextType !== 'string') errors.push({ field: 'contextType', message: 'is required' });
  if (input.contextId !== undefined && input.contextId !== null && typeof input.contextId !== 'string') {
    errors.push({ field: 'contextId', message: 'must be a string when present' });
  }
  if (input.visibility !== undefined && !isFileVisibility(input.visibility)) {
    errors.push({ field: 'visibility', message: 'must be public or private' });
  }
  if (errors.length > 0) throw validationError(errors);

  // An unknown context VALUE is a 422, not a 400: the caller named a context this platform may one
  // day have, and `FILE_CONTEXT_NOT_AVAILABLE` says so without revealing what is registered.
  if (!isFileContextType(input.contextType)) throw fileContextNotAvailableError(String(input.contextType));

  return {
    kind: input.kind as FileKind,
    mimeType: input.mimeType as string,
    sizeBytes: input.sizeBytes as number,
    fileName: input.fileName as string,
    contextType: input.contextType,
    contextId: (input.contextId as string | null | undefined) ?? null,
    visibility: input.visibility as FileVisibility | undefined,
  };
}

export interface UploadUrlInput {
  session: Pick<SessionRow, 'userId' | 'activeMode'>;
  request: UploadUrlRequest;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  correlationId: string;
}

/**
 * AC-8's "no row is created" is load-bearing: the context is resolved and the caller authorized
 * BEFORE the insert, so an unregistered context or an unauthorized caller can never leave behind an
 * asset nobody knows how to authorize.
 */
export async function createUploadTarget(input: UploadUrlInput): Promise<UploadTargetDto> {
  const { session, request, correlationId } = input;

  const policy = getFileContextPolicy(request.contextType);
  if (!policy) throw fileContextNotAvailableError(request.contextType);

  // AC-1's first enforcement point: no bytes are written for a file that could not be accepted.
  // This checks only what the CALLER declared, so it reveals nothing about the context.
  const { mimeType } = validateDeclaredUpload(request);

  // `contextId` is optional on the wire and an absent one means the same as an explicit null,
  // so only a PRESENT value is shape-checked.
  const contextId = request.contextId ?? null;
  if (contextId !== null && !isUuid(contextId)) throw fileNotFoundError();

  const mayUpload = await policy.canUpload({
    userId: session.userId,
    activeMode: session.activeMode,
    contextId: request.contextId ?? null,
  });
  // Indistinguishable from "no such context id" (AC-6): an unauthorized caller learns nothing.
  if (!mayUpload) throw fileNotFoundError();

  // Deliberately AFTER authorization: which kinds a context accepts is information about that
  // context, so a stranger must not be able to probe it. `data_export` allows no kind at all, which
  // is why an unauthorized caller is refused before ever reaching this line.
  if (!policy.allowedKinds.includes(request.kind)) {
    throw fileTypeNotAllowedError(`A ${request.kind} cannot be attached to ${request.contextType}.`);
  }

  const db = getDb();

  // An idempotent replay must return the ORIGINAL target rather than reserving a second one.
  const replay = await findByIdempotencyKey(session.userId, input.idempotencyKey);
  if (replay) {
    if (replay.idempotency_fingerprint !== input.idempotencyFingerprint) throw idempotencyKeyConflictError();
    return buildTarget(replay, mimeType);
  }

  if ((await countContextAssets(db, request.contextType, request.contextId ?? null)) >= policy.maxPerContext) {
    throw fileContextLimitReachedError(policy.maxPerContext);
  }

  // AC-2/§3: `visibility` is DERIVED. A caller may ask for public, but only a `publicEligible`
  // context can grant it; every other context is private no matter what was sent.
  const visibility: FileVisibility = policy.publicEligible && request.visibility === 'public' ? 'public' : 'private';

  const fileAssetId = randomUUID();
  const storageKey = deriveStorageKey(session.userId, fileAssetId);
  const fileName = sanitizeFileName(request.fileName);

  let row: FileAssetRow;
  try {
    const inserted = await queryRows<FileAssetRow>(
      db,
      sql`INSERT INTO file_assets
            (id, uploaded_by_user_id, kind, visibility, status, storage_key, mime_type, size_bytes,
             file_name, context_type, context_id, idempotency_key, idempotency_fingerprint)
          VALUES (${fileAssetId}, ${session.userId}, ${request.kind}, ${visibility}, 'pending', ${storageKey},
                  ${mimeType}, ${request.sizeBytes}, ${fileName}, ${request.contextType},
                  ${request.contextId ?? null}, ${input.idempotencyKey}, ${input.idempotencyFingerprint})
          RETURNING ${FILE_ASSET_COLUMNS}`,
    );
    row = inserted[0]!;
  } catch (err) {
    // Two concurrent identical calls: the loser reads the winner's row rather than creating a second.
    if (isUniqueViolation(err, 'file_assets_owner_idempotency_uq')) {
      const winner = await findByIdempotencyKey(session.userId, input.idempotencyKey);
      if (!winner) throw err;
      if (winner.idempotency_fingerprint !== input.idempotencyFingerprint) throw idempotencyKeyConflictError();
      return buildTarget(winner, mimeType);
    }
    throw err;
  }

  logFileEvent('file.upload_requested', {
    correlationId,
    fileAssetId: row.id,
    contextType: row.context_type,
    kind: row.kind,
    status: row.status,
  });

  return buildTarget(row, mimeType);
}

async function findByIdempotencyKey(userId: string, key: string): Promise<FileAssetRow | null> {
  const [row] = await queryRows<FileAssetRow>(
    getDb(),
    sql`SELECT ${FILE_ASSET_COLUMNS} FROM file_assets
         WHERE uploaded_by_user_id = ${userId} AND idempotency_key = ${key}`,
  );
  return row ?? null;
}

async function buildTarget(row: FileAssetRow, mimeType: string): Promise<UploadTargetDto> {
  const adapter = adapterOrThrow();
  const ttlSeconds = uploadUrlTtlSeconds();
  const target = await adapter.createUploadTarget({
    storageKey: row.storage_key!,
    mimeType,
    maxBytes: Number(row.size_bytes ?? 0),
    ttlSeconds,
  });
  return {
    fileAsset: toFileAssetDto(row),
    upload: {
      url: target.url,
      method: target.method,
      headers: target.headers,
      expiresAt: target.expiresAt.toISOString(),
    },
  };
}

/**
 * AC-1's second enforcement point and AC-4's entry into scanning.
 *
 * Idempotent by nature: a second call on an already-`ready`/`rejected` asset returns the row
 * unchanged — which is why `finalize` needs no `Idempotency-Key` of its own.
 */
export async function finalizeUpload(
  session: Pick<SessionRow, 'userId'>,
  fileAssetId: string,
  correlationId: string,
): Promise<FileAssetDto> {
  if (!isUuid(fileAssetId)) throw fileNotFoundError();

  const asset = await findLiveAsset(fileAssetId);
  // Ownership, not readability: only the uploader finalizes. Anyone else gets `404` (AC-6).
  if (!asset || asset.uploaded_by_user_id !== session.userId) throw fileNotFoundError();

  if (asset.status === 'ready' || asset.status === 'rejected') return toFileAssetDto(asset);

  const adapter = adapterOrThrow();
  const head = await adapter.head(asset.storage_key!);
  if (!head.exists) throw fileNotUploadedError();

  const prefix = await adapter.readPrefix(asset.storage_key!, MAGIC_BYTE_PREFIX_LENGTH);
  const verdict = validateActualObject(
    { kind: asset.kind, mimeType: asset.mime_type ?? '', sizeBytes: Number(asset.size_bytes ?? 0) },
    { sizeBytes: head.sizeBytes, prefix },
  );

  if (!verdict.ok) {
    // AC-1: the bytes are purged, not merely ignored — a rejected object is never left readable.
    await adapter.delete(asset.storage_key!).catch(() => undefined);
    const rejected = await markRejected(fileAssetId, verdict.reasonCode);
    logFileEvent('file.rejected', {
      correlationId,
      fileAssetId,
      contextType: asset.context_type,
      kind: asset.kind,
      status: 'rejected',
      reasonCode: verdict.reasonCode,
    });
    return toFileAssetDto(rejected ?? { ...asset, status: 'rejected', rejection_reason: verdict.reasonCode });
  }

  // The ACTUAL size replaces the declared one — the declaration was only ever a pre-check.
  const [scanning] = await queryRows<FileAssetRow>(
    getDb(),
    sql`UPDATE file_assets
           SET status = 'scanning', size_bytes = ${verdict.sizeBytes}, mime_type = ${verdict.mimeType},
               scan_next_attempt_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${fileAssetId} AND status = 'pending'
         RETURNING ${FILE_ASSET_COLUMNS}`,
  );
  const current = scanning ?? (await findLiveAsset(fileAssetId));
  if (!current) throw fileNotFoundError();

  logFileEvent('file.finalized', {
    correlationId,
    fileAssetId,
    contextType: current.context_type,
    kind: current.kind,
    status: current.status,
  });

  // §8 #11: the inline attempt is BEST EFFORT and bounded. A slow or failing scanner delays
  // availability, never the response — anything unresolved falls to the maintenance sweep.
  const scanned = await runScanForAsset(current, correlationId).catch(() => null);
  return toFileAssetDto(scanned ?? current);
}

async function markRejected(fileAssetId: string, reasonCode: string): Promise<FileAssetRow | null> {
  const [row] = await queryRows<FileAssetRow>(
    getDb(),
    sql`UPDATE file_assets
           SET status = 'rejected', rejection_reason = ${reasonCode}, scan_next_attempt_at = NULL,
               storage_deleted_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${fileAssetId} AND status IN ('pending','scanning')
         RETURNING ${FILE_ASSET_COLUMNS}`,
  );
  return row ?? null;
}
