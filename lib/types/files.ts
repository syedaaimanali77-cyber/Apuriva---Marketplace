/**
 * Spec 027 §3 "Types" — the file/media vocabulary and the DTOs its routes return.
 *
 * Deliberately transport-only: no storage key, no checksum, no scanner internals, no owner id and
 * no signature material ever reaches a client (§4 "Retention and privacy"). Those are server-side
 * routing and diagnostic data, and `FileAssetDto` is the whole of what a caller may see.
 */

export const FILE_KINDS = ['image', 'video', 'document'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_VISIBILITIES = ['public', 'private'] as const;
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

export const FILE_STATUSES = ['pending', 'scanning', 'ready', 'rejected'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * Closed vocabulary (C-2 at the database). A value is only USABLE while a context policy is
 * registered for it (AC-8) — the reserved entries below are `422 FILE_CONTEXT_NOT_AVAILABLE`
 * until their owning spec registers a resolver. `booking_evidence` is registered by spec 028
 * (`lib/bookings/evidence-policy.ts`) and `review_media` by spec 029
 * (`lib/reviews/media-policy.ts`); `dispute_evidence` and `verification_document` are still
 * reserved. Adding a value is a migration, since the database CHECK is the real vocabulary.
 */
export const FILE_CONTEXT_TYPES = [
  'request_attachment', // spec 015 — shipped
  'message_attachment', // spec 025 — shipped
  'portfolio', // provider's own profile media — the one public-eligible context
  'data_export', // spec 008 — server-generated; never uploadable, never readable through spec 027
  'booking_evidence', // spec 028 — reserved, no resolver yet
  'dispute_evidence', // spec 031 — reserved, no resolver yet
  'verification_document', // provider identity documents — reserved, no resolver yet
  'review_media', // spec 029 — registered by `lib/reviews/media-policy.ts`
] as const;
export type FileContextType = (typeof FILE_CONTEXT_TYPES)[number];

/** The scanner's verdict (AC-4). `unknown` is NOT a terminal state and never yields `ready`. */
export const SCAN_OUTCOMES = ['clean', 'rejected', 'unknown'] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === 'string' && (FILE_KINDS as readonly string[]).includes(value);
}

export function isFileVisibility(value: unknown): value is FileVisibility {
  return typeof value === 'string' && (FILE_VISIBILITIES as readonly string[]).includes(value);
}

export function isFileContextType(value: unknown): value is FileContextType {
  return typeof value === 'string' && (FILE_CONTEXT_TYPES as readonly string[]).includes(value);
}

export interface FileAssetDto {
  id: string;
  kind: FileKind;
  visibility: FileVisibility;
  status: FileStatus;
  mimeType: string | null;
  sizeBytes: number | null;
  fileName: string | null;
  contextType: FileContextType;
  contextId: string | null;
  /** Present only for `rejected`, and only a code — never scanner internals. */
  rejectionReason: string | null;
  createdAt: string;
  readyAt: string | null;
  version: number;
}

export interface FileUrlDto {
  url: string;
  /** Null for a CDN URL, which has no expiry. */
  expiresAt: string | null;
  visibility: FileVisibility;
}

/** What `POST /files/upload-url` hands back: where to PUT the bytes, and the row reserved for them. */
export interface UploadTargetDto {
  fileAsset: FileAssetDto;
  upload: {
    url: string;
    method: 'PUT' | 'POST';
    headers: Record<string, string>;
    expiresAt: string;
  };
}

/** The declared values `POST /files/upload-url` validates BEFORE any byte is written (AC-1). */
export interface UploadUrlRequest {
  kind: FileKind;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
  contextType: FileContextType;
  contextId?: string | null;
  /** Honoured only when the context policy is `publicEligible`; otherwise silently private (AC-2). */
  visibility?: FileVisibility;
}
