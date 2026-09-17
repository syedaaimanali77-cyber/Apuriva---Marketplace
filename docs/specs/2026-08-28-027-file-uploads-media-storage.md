# Spec: File Uploads & Media Storage

**File:** `docs/specs/2026-08-28-027-file-uploads-media-storage.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §56, §102, §117, §132.21–§132.22, §133.5–§133.7, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §11, [docs/workflow.md](../workflow.md)

**Depends on:** 003 (the `file_assets` / `message_attachments` baseline skeletons, `baseColumns()`,
optimistic `version`), 004 (`withApiRoute`, the error taxonomy, rate-limit domains,
`OPENAPI_ROUTES`, `lib/api/idempotency.ts`), 005 (`requireSession`, `requireCsrf`, `deriveKey`,
`recordSecurityEvent`), 008 (`FileAssetStorage` — the storage PORT this spec finally implements —
plus export/deletion), 009 (`recordAdminAuditEvent`), 015 (`request_attachments`), 021 (the
adapter/env/production-guard pattern), 025 (`resolveConversationAccess`), 026 (the cron sweep,
retry/`unknown` and port-registration idioms this spec copies).

**Feeds:** 008 (its export artifact finally has a real storage backend), 015/025 (their attachment
linkage becomes usable), 028/029/031 and the provider-portfolio spec (each registers its own
context resolver; none is implemented here).

---

## 1. Problem statement

**Today:** No file or media handling exists. Verified in the repository, not assumed:

| What exists today | Where | State |
|---|---|---|
| `file_assets` | spec 003 baseline | skeleton: `id`, audit, `version`, **nullable** `uploaded_by_user_id` — no key, size, MIME, status or visibility |
| `message_attachments` | spec 003 baseline | skeleton: `id`, audit, `version`, `message_id` — spec 025 left it untouched for this spec |
| `request_attachments` | spec 015 | real linkage (`request_id` + `file_asset_id`), ownership-validated; **already shipped** |
| `FileAssetStorage` port | `lib/privacy/file-asset-storage.ts` (spec 008) | `store`/`retrieve` only; `getFileAssetStorage()` **throws** until this spec registers an implementation |
| `users.data_export_file_asset_id` | spec 008 | spec 008 inserts a **bare** `file_assets` row and stores bytes through the port |
| Signed-link precedent | `lib/privacy/download-token.ts` (spec 008) | stateless HMAC over id + expiry, `deriveKey('data-export-download')` |

So a `FileAsset` id can be *referenced* by three shipped specs, but no client can legitimately
obtain one, and no bytes can be stored anywhere: `lib/payouts/statement.ts` and spec 008's export
sweep both fail loudly by design until this spec ships.

Master spec §56/§102 and architecture §11 require object storage, CDN delivery for public media,
private storage with signed time-limited URLs for sensitive media, type/size limits,
malware/security checks, upload progress, preview and strict access control.

**Who is affected:** Every customer attaching a photo to a request (015); both parties on a booking
conversation (025); Trust & Safety reviewing evidence later (028/031); every user exercising data
export (008), which cannot complete today.

**Why it matters now:** Three shipped specs reference `FileAsset` as though it works. Until this
spec lands, "attach a file" is false everywhere it is written, and spec 008's export is permanently
`failed`.

**Success looks like:** One `POST /files/upload-url` → `POST /files/{id}/finalize` pipeline that
validates type and size **server-side**, stores bytes through a swappable adapter, scans before the
file is readable by anyone, and serves private assets only through short-lived signed URLs whose
every fetch is re-authorized — with no vendor, no invented credential, and no fake success.

---

## 2. Acceptance criteria

The six original criteria are preserved and made deterministic: AC-1 gains a defined enforcement
point (declared *and* actual), AC-2 an explicit "public-eligible" definition, AC-3 a stated TTL and
issuing rule, AC-4 the `unknown`-scan rule, AC-5 the server-confirmation boundary, AC-6 the
re-authorization rule that makes a leaked or expired link worthless. AC-7 through AC-11 are added
because without them the lifecycle, context authorization, deletion, spec 008 compatibility and the
absence of a real vendor are unspecified — each is traceable to a named test in §6.

| # | Criterion |
|---|---|
| AC-1 | **Given** a file whose type is not on the allowlist, or whose size exceeds that kind's configured limit **When** it is uploaded **Then** it is rejected with `400 FILE_TYPE_NOT_ALLOWED` / `400 FILE_TOO_LARGE` — at `upload-url` on the **declared** values (so no bytes are ever written) and again at `finalize` on the **actual** stored object (size from the adapter, type from magic-byte sniffing), where a mismatch rejects the asset and purges the bytes. It is never truncated, never silently accepted, and never left readable |
| AC-2 | **Given** a **public-eligible** asset — a `portfolio` image whose context policy permits `visibility: 'public'` — **When** it is `ready` **Then** `GET /files/{id}` returns a CDN URL built by the storage adapter with the optimization parameters this spec's `ImageOptimizer` port defines (width cap + quality), and **never** before `ready` |
| AC-3 | **Given** a private asset **When** an authorized caller requests it **Then** they receive a signed URL that expires after `FILE_SIGNED_URL_TTL_SECONDS` (default 300) and is bound to that caller; no permanently public path to a private object exists, and the storage adapter exposes no public URL for a private asset |
| AC-4 | **Given** any upload **When** it is finalized **Then** it enters `scanning` and the configured `FileScanner` must return `clean` before it becomes `ready`. `rejected` is terminal; `unknown` (or a scanner failure) leaves it **non-`ready`** and retryable — never `ready` on a guess — so a file with an unresolved scan is never readable by anyone, including its owner's counterparty |
| AC-5 | **Given** an in-progress upload **When** the user is on a slow connection **Then** determinate progress is shown from real bytes-sent events, and the UI shows the file as attached only after the server's `finalize` response; a client-side "100%" never means done |
| AC-6 | **Given** an asset owned by one user **When** another user requests it — with a guessed id, a leaked signed URL or an expired one — **Then** access is denied server-side: authorization is re-resolved on **every** issue and **every** content fetch, a signature is bound to `(fileAssetId, userId, expiry)` and is worthless to anyone else, an expired signature is refused outright, and an unauthorized id is `404 FILE_NOT_FOUND`, never `403`, so ids cannot be probed |
| AC-7 | **Given** the lifecycle `pending → scanning → ready \| rejected` **When** any transition is attempted **Then** it is enforced server-side and at the database: `ready_at` is set exactly when `status = 'ready'`, `rejection_reason` exactly when `status = 'rejected'`, a terminal state (`ready`/`rejected`) can never change, and no client-supplied field can set `status`, `visibility`, `owner`, `context`, `storage_key` or `size_bytes` |
| AC-8 | **Given** a `context_type` **When** an upload is requested for it **Then** it is accepted only if a context resolver is registered for it; an unregistered or unknown context is `422 FILE_CONTEXT_NOT_AVAILABLE` and **no row is created** — so a context whose owning spec has not shipped can never become an unauthorizable asset, and `context_type` can never be an authorization bypass |
| AC-9 | **Given** an owner deleting their asset **When** `DELETE /files/{id}` succeeds **Then** the row is soft-deleted (`deleted_at`), it immediately reads as `404` to everyone, its linkage rows are untouched (every FK stays `RESTRICT`), and its bytes are purged by the maintenance sweep after `FILE_PURGE_GRACE_DAYS` **unless** it is under `legal_hold`, which is retained as evidence with its filename redacted |
| AC-10 | **Given** spec 008's export pipeline **When** this spec's migration and storage adapter are in place **Then** the export's existing bare `file_assets` insert and its `store`/`retrieve` calls keep working **unchanged** — this spec registers the port spec 008 has always depended on and modifies no spec 008 code path |
| AC-11 | **Given** no real object-storage, CDN or malware-scanning vendor exists in this repository **When** any of them is used **Then** it goes through this spec's adapter/port seam; the local-disk storage adapter and the sandbox scanner **refuse to run under `NODE_ENV=production`** (spec 021 AC-10 / spec 026 AC-10's guard), so a production deployment without real adapters fails loudly instead of pretending a file was stored, scanned or delivered |

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism reused | Not created |
|---|---|---|
| Storage capability contract | spec 008's `FileAssetStorage` (`lib/privacy/file-asset-storage.ts`) — **implemented**, never replaced | a second storage seam |
| Signed-link scheme | spec 008's stateless HMAC pattern (`lib/privacy/download-token.ts`, `deriveKey`) | a token table |
| Adapter selection + production guard | spec 021's `PAYMENT_PROVIDER` / spec 026's `NOTIFICATION_CHANNEL_PROVIDER` env pattern | a feature-flag system (spec 041) |
| Background work | the Vercel Cron + `CRON_SECRET` pattern (ten shipped scheduled routes) | a worker service — **`apps/worker` does not exist in this repository** |
| Idempotency | spec 015's `lib/api/idempotency.ts` + per-entity key columns | a second scheme |
| Session/CSRF/rate limit/pagination/errors | specs 004/005 | a second auth or envelope path |
| Participant authorization | spec 025's `resolveConversationAccess`, spec 015's owned-request read | duplicated ownership rules |
| Admin audit | spec 009's `recordAdminAuditEvent` (`security_events`) | a new audit store |
| Privacy export/deletion | spec 008's `generateExportPayload` / `sweepDeletions` | a second retention mechanism |

### Repository paths (normative — the draft's monorepo paths do not exist)

| Draft said | Actual repository location |
|---|---|
| `packages/types/src/files.ts` | `lib/types/files.ts` |
| `apps/api/files/**` | `lib/files/**` (domain) + `app/api/v1/files/**/route.ts` (routes) |
| `apps/web` components | `app/_components/FileUpload.tsx`, `app/_components/MediaPreview.tsx` (+ module CSS) |
| `packages/ui` `FileUpload`, `MediaPreview` | do **not** exist and are not created in `ui/`; the app components compose existing primitives |
| `apps/web-e2e/file-upload.spec.ts` | `e2e/file-upload.spec.ts` (Vitest — there is no Playwright; `e2e/*.spec.ts` is a configured Vitest pattern) |

### Ownership boundary (normative)

| Concern | Owner |
|---|---|
| Upload lifecycle, validation, scanning, storage, signed URLs, deletion | **027** |
| **Whether** a feature requires a file, how many, and what it means | the consuming spec (015/025/028/029/031/portfolio) |
| Who may see a file in a given context | the consuming spec's **registered resolver** (§3 "Context authorization") |
| A real storage/CDN vendor, a real scanner, a real image pipeline | **out of scope** — later specs supply adapters |
| Audit storage and querying | 039 (this spec emits through spec 009's helper) |

### Types

```typescript
// lib/types/files.ts
export const FILE_KINDS = ['image', 'video', 'document'] as const;
export const FILE_VISIBILITIES = ['public', 'private'] as const;
export const FILE_STATUSES = ['pending', 'scanning', 'ready', 'rejected'] as const;

/** Closed vocabulary. A value is only USABLE while a resolver is registered for it (AC-8). */
export const FILE_CONTEXT_TYPES = [
  'request_attachment',   // spec 015 — shipped
  'message_attachment',   // spec 025 — shipped
  'portfolio',            // provider's own profile media — the one public-eligible context
  'data_export',          // spec 008 — server-generated; never uploadable, never readable here
  'booking_evidence',     // spec 028 — reserved, no resolver yet
  'dispute_evidence',     // spec 031 — reserved, no resolver yet
  'verification_document' // spec 029 — reserved, no resolver yet
] as const;

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
```

`FileAssetDto` deliberately carries **no** `storageKey`, scan internals, owner id or signature
material: those are server-side routing and diagnostic data.

### Endpoints

Conventions: `app/api/v1/**/route.ts`; `withApiRoute` forwards no route context, so an `{id}` route
reads its parameter from the URL; guard order is **session → CSRF → rate limit**. Files are
**user-level, not mode-scoped**, except a `message_attachment` read, which inherits spec 025's
mode rule for the conversation it belongs to.

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/files/upload-url` | session | `200 ApiResponse<UploadTargetDto>` | CSRF; **`Idempotency-Key` required** (it creates a row and reserves storage); replay returns the same target, a changed body is `409 IDEMPOTENCY_KEY_CONFLICT` |
| `POST` | `/api/v1/files/{id}/finalize` | session (owner) | `200 ApiResponse<FileAssetDto>` | CSRF; naturally idempotent (a second call returns the current row) — **no** key |
| `GET` | `/api/v1/files/{id}` | session (authorized per context) | `200 ApiResponse<FileUrlDto>` | signed URL for private, CDN URL for public; `ready` only |
| `GET` | `/api/v1/files/{id}/content` | **signature** (session optional) | `200` bytes | the local adapter's signed-URL target; re-verifies signature, expiry **and authorization** on every fetch (AC-6) |
| `DELETE` | `/api/v1/files/{id}` | session (owner) | `204` | CSRF; soft delete, idempotent |
| `GET` | `/api/v1/cron/file-maintenance-sweep` | `Bearer ${CRON_SECRET}` | `200` | scan pass + byte-purge pass; not a browser route: no session/CSRF/rate limit, excluded from OpenAPI like every cron route |

**There is deliberately no route that sets `status`, `visibility`, `owner`, `context` or
`storage_key`.** All are server-derived (AC-7). `data_export` assets are refused by every route
here (`404`): spec 008's own signed download route remains their only path, so this spec never
becomes a second way to reach an export.

**Rate limiting.** One new domain — `files: { limit: 30, windowMs: 60_000 }` in
`RATE_LIMIT_DEFAULTS` — the same write-surface budget specs 015/017/018/020 chose, because these
calls reserve storage and issue credentials. `GET /files/{id}/content` uses the same domain keyed by
the bound user id.

### Storage adapter seam (AC-3, AC-11)

```typescript
// lib/files/storage/types.ts
export interface UploadTarget { url: string; method: 'PUT' | 'POST'; headers: Record<string, string>; expiresAt: Date }

export interface FileStorageAdapter {
  readonly name: string;
  readonly isSandbox?: boolean;
  /** Pre-signed (or local) destination for the client's bytes. */
  createUploadTarget(input: { storageKey: string; mimeType: string; maxBytes: number; ttlSeconds: number }): Promise<UploadTarget>;
  /** Existence + ACTUAL size/type, read at finalize — never trusted from the client (AC-1). */
  head(storageKey: string): Promise<{ exists: boolean; sizeBytes: number; contentType: string | null }>;
  /** First N bytes, for magic-byte sniffing at finalize. */
  readPrefix(storageKey: string, byteCount: number): Promise<Buffer>;
  readAll(storageKey: string): Promise<Buffer | null>;
  /** Server-side write — spec 008's export artifact and finalize-time variants. */
  write(storageKey: string, bytes: Buffer, contentType: string): Promise<void>;
  delete(storageKey: string): Promise<void>;
  /** Private objects only. The URL must expire; the adapter never returns a permanent one. */
  createSignedUrl(input: { storageKey: string; fileAssetId: string; userId: string; ttlSeconds: number }): Promise<{ url: string; expiresAt: Date }>;
  /** Public objects only, and only for a `ready` asset. `null` when no CDN is configured. */
  publicUrl(input: { storageKey: string; transform?: ImageTransform }): string | null;
}
```

- Selection is `process.env.FILE_STORAGE_PROVIDER` (default `local`), read fresh on every call; an
  unknown name **throws** (`FileStorageUnavailable` → `503 FILE_STORAGE_UNAVAILABLE`) rather than
  falling back, exactly as `resolvePaymentProvider`/`resolveNotificationChannelAdapters` do.
- **`local` is a development/test adapter** (master §133.7): bytes under
  `FILE_STORAGE_LOCAL_DIR` (default a directory in the OS temp dir, so nothing lands in the repo and
  `.gitignore` is untouched), `createUploadTarget` returns this app's own
  `PUT /api/v1/files/{id}/content?...` target, `publicUrl` returns `null` unless
  `FILE_PUBLIC_CDN_BASE_URL` is set, and it **throws under `NODE_ENV=production`** (AC-11).
- Spec 008's `FileAssetStorage` (`store`/`retrieve` of a string) is implemented **on top of** this
  adapter by `lib/files/storage/legacy-port.ts` and registered from `instrumentation.ts`. Spec 008's
  code is not touched (AC-10).

### Scanning (AC-4)

```typescript
// lib/files/scanning/types.ts
export type ScanOutcome = 'clean' | 'rejected' | 'unknown';
export interface FileScanner {
  readonly name: string;
  readonly isSandbox?: boolean;
  scan(input: { fileAssetId: string; storageKey: string; mimeType: string; sizeBytes: number }): Promise<{ outcome: ScanOutcome; reasonCode?: string }>;
}
```

- Selected by `FILE_SCANNER` (default `sandbox`); the sandbox **throws under `NODE_ENV=production`**.
- The sandbox is **deterministic and documented**, not a pretend antivirus: it rejects the standard
  **EICAR** test string and any object whose first bytes match the documented
  `APURIVA-TEST-UNSAFE` marker (`reasonCode: 'test_marker'`), returns `unknown` for the
  `APURIVA-TEST-UNKNOWN` marker, and returns `clean` otherwise. It claims no detection capability.
- Scanning runs at `finalize` (inline, best effort) and, for anything still unresolved, in the
  maintenance sweep with `2^attempts`-minute backoff up to `FILE_SCAN_MAX_ATTEMPTS` (default 5).
- `clean` → `ready` (+ `ready_at`). `rejected` → terminal `rejected`, bytes purged immediately,
  `rejection_reason` a code. `unknown`/throw → stays `scanning`, attempt counted, **never** `ready`;
  at the ceiling it stops being auto-claimed and logs `file.scan_unresolved` for an operator — the
  same "never a guessed terminal" rule spec 026 applies to `unknown` deliveries.

### Image optimization (AC-2)

```typescript
// lib/files/optimization/types.ts
export interface ImageTransform { width?: number; quality?: number; format?: 'auto' | 'webp' }
export interface ImageOptimizer {
  readonly name: string;
  /** May decline: a repository with no image library must say so rather than claim a resize. */
  optimize(input: { storageKey: string; mimeType: string; sizeBytes: number }): Promise<{ optimized: false; reason: string } | { optimized: true; storageKey: string; sizeBytes: number }>;
  /** The transform a delivery URL should carry for this kind of asset. */
  deliveryTransform(input: { mimeType: string }): ImageTransform;
}
```

- No image-processing dependency exists in `package.json` and none is added. The default
  `passthrough` optimizer returns `{ optimized: false, reason: 'no_optimizer' }` and supplies the
  **delivery transform** (`width: 1600`, `quality: 80`, `format: 'auto'`) that the CDN URL carries —
  which is how AC-2's "reasonable resizing/compression" is honestly met without inventing a vendor
  pipeline: the transform is expressed at delivery, and a later adapter (CDN transform or a real
  library) implements it behind this port with nothing else changing.
- **No variants table.** Derivative objects are a later spec's concern; the MVP stores one object
  per asset.

### Upload lifecycle (AC-1, AC-4, AC-5, AC-7)

```
POST /files/upload-url                    POST /files/{id}/finalize
   │  validate DECLARED kind/mime/size       │  head() → ACTUAL size
   │  resolve context (AC-8)                 │  readPrefix() → magic-byte sniff
   │  row: pending, storage_key reserved     │  mismatch/oversize → rejected + purge
   ▼                                         ▼
pending ──────────────► scanning ──► ready        (clean)
   │  (bytes uploaded)     │      └─► rejected    (rejected; bytes purged)
   │                       └────────► scanning    (unknown → retried, never ready)
   └─► expired (never finalized) → purged by the sweep after FILE_UPLOAD_URL_TTL_SECONDS
```

- A `pending` asset is readable by **nobody**, including its owner: `GET /files/{id}` answers
  `409 FILE_NOT_READY`. Only `ready` yields a URL.
- `finalize` is idempotent: on an already-`ready`/`rejected` asset it returns the row unchanged.
- The magic-byte sniff covers the allowlist (JPEG `FF D8 FF`, PNG, WebP/RIFF, PDF `%PDF-`, MP4
  `ftyp`); a declared type that does not match its bytes is `400 FILE_TYPE_NOT_ALLOWED` and the
  asset is `rejected` — this is what stops a `.jpg`-labelled executable.

### Limits (resolves spec 015 §8 #1 for this spec's side)

Nothing in the master spec fixes a number, so these are **explicit product defaults**, every one
environment-configurable, not invented requirements:

| Kind | Allowed MIME | Max bytes (env) |
|---|---|---|
| image | `image/jpeg`, `image/png`, `image/webp` | `FILE_MAX_IMAGE_BYTES` = 10 MB |
| document | `application/pdf` | `FILE_MAX_DOCUMENT_BYTES` = 20 MB |
| video | `video/mp4` | `FILE_MAX_VIDEO_BYTES` = 100 MB |

Per-context count caps live in the context policy (`request_attachment` 5, `message_attachment` 5,
`portfolio` 20) and are enforced at `upload-url` (`422 FILE_CONTEXT_LIMIT_REACHED`). Spec 015's open
question #1 is thereby answered **here**, where the columns to enforce it exist; spec 015 is not
edited.

### Context authorization (AC-6, AC-8)

A registry, so this spec never encodes another spec's business rules:

```typescript
// lib/files/contexts/registry.ts
export interface FileContextPolicy {
  /** May this context ever be public? Only `portfolio` is true today. */
  publicEligible: boolean;
  maxPerContext: number;
  allowedKinds: readonly FileKind[];
  /** May this caller ATTACH to this context id? Checked at upload-url. */
  canUpload(input: { userId: string; activeMode: ActiveMode; contextId: string | null }): Promise<boolean>;
  /** May this caller READ this asset? Re-run on every URL issue and every content fetch. */
  canRead(input: { userId: string; activeMode: ActiveMode; asset: FileAssetRow }): Promise<boolean>;
}
export function registerFileContextPolicy(type: FileContextType, policy: FileContextPolicy): void;
```

Shipped policies (the only contexts usable at launch):

| Context | Upload | Read | Visibility |
|---|---|---|---|
| `request_attachment` | the request's owning customer (`requests.customer_profile_id` → `customer_profiles.user_id`) | the same owner; a provider gains access only when its owning spec registers that rule | private |
| `message_attachment` | a booking participant in their own active mode, conversation not archived — spec 025's `resolveConversationAccess`, reused not re-implemented | both participants; a support/trust-&-safety admin with `messaging/read_conversation`, **audited** via `recordAdminAuditEvent` | private |
| `portfolio` | the uploader's own `provider_profiles` row | anyone once `ready` (public) | **public-eligible** |
| `data_export` | never (server-generated) | never through this spec's routes | private |
| `booking_evidence`, `dispute_evidence`, `verification_document` | **no resolver registered** → `422 FILE_CONTEXT_NOT_AVAILABLE` | n/a | private |

`visibility` is **derived**, never accepted from the client: `public` only when the policy is
`publicEligible` *and* the caller asked for public; otherwise `private`.

### Signed URLs and why a stale link cannot bypass authorization (AC-3, AC-6)

`createSignedUrl` signs `(fileAssetId, userId, expiresAt)` with `deriveKey('file-download')` — spec
008's exact stateless pattern. `GET /files/{id}/content` then, on **every** fetch, in order:
verifies the signature and that it is unexpired → loads the asset → refuses unless `status = 'ready'`
and `deleted_at IS NULL` → **re-runs `canRead` for the bound user id**. So a link that leaks to
another user is useless (it is bound to the original user), an expired link is refused, and a link
held by a user whose access was since revoked (conversation archived, request deleted, admin role
removed) stops working at the next fetch. A signature is never an authorization of its own.

### Error codes

None belongs in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status`
explicitly — the pattern specs 005/016/020–026 follow.

| HTTP | `code` | When |
|---|---|---|
| `400` | `FILE_TYPE_NOT_ALLOWED` | MIME not on the allowlist, or bytes that do not match the declared type |
| `400` | `FILE_TOO_LARGE` | declared or actual size over the kind's limit |
| `400` | `VALIDATION_ERROR` | malformed body, unknown kind, missing `Idempotency-Key` |
| `404` | `FILE_NOT_FOUND` | no such asset, soft-deleted, **or** not authorized — deliberately indistinguishable (AC-6) |
| `403` | `FORBIDDEN` | a booking participant reading a `message_attachment` in the wrong active mode (spec 025's rule) |
| `409` | `FILE_NOT_READY` | `pending`/`scanning` — the file exists but is not available to anyone yet |
| `409` | `FILE_REJECTED` | terminal `rejected`; `details.reasonCode` |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | same key, different `upload-url` body |
| `422` | `FILE_CONTEXT_NOT_AVAILABLE` | unknown context, or one with no registered policy |
| `422` | `FILE_CONTEXT_LIMIT_REACHED` | the context's count cap is reached |
| `422` | `FILE_NOT_UPLOADED` | `finalize` when the adapter reports no object at the key |
| `429` | `RATE_LIMITED` | spec 004's code, new `files` domain |
| `503` | `FILE_STORAGE_UNAVAILABLE` | no/unknown storage adapter, or a sandbox refused in production |

### OpenAPI

The five browser routes are added to `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`) tagged
`files`, in the same change, or `npm run check:openapi-drift` fails. The cron route is excluded like
every other cron route. The pre-existing spec 010 `{categoryId}` drift is **not** touched.

### Breaking-change check

- [x] New routes; new columns on two empty-or-bare spec 003 baseline tables; **no new table**.
- [x] No shipped API contract changes. Spec 008's port is *implemented*, never modified.

---

## 4. Data model changes

`file_assets` and `message_attachments` **already exist** as spec 003 baseline skeletons; this spec
**alters** them and adds **no table**. The draft's "`FileAsset` | new" is wrong and is corrected.
`0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.

### Entities

| Entity | Change | Columns added |
|---|---|---|
| `file_assets` | **alter** (baseline: nullable `uploaded_by_user_id`) | `kind text not null default 'document'`, `visibility text not null default 'private'`, `status text not null default 'pending'`, `storage_key text null` (unique when not null), `mime_type text null`, `size_bytes integer null`, `file_name text null`, `checksum_sha256 text null`, `context_type text null`, `context_id uuid null`, `scan_outcome text null`, `scan_attempts integer not null default 0`, `scan_next_attempt_at timestamptz null`, `rejection_reason text null`, `ready_at timestamptz null`, `deleted_at timestamptz null`, `storage_deleted_at timestamptz null`, `legal_hold boolean not null default false`, `idempotency_key text null`, `idempotency_fingerprint text null` |
| `message_attachments` | **alter** (baseline: `message_id`) | `file_asset_id uuid not null fk->file_assets restrict` |
| `request_attachments` | **unchanged** | spec 015 already ships the linkage |

**Every added column is nullable or defaulted, on purpose.** Spec 008 already inserts a *bare*
`file_assets` row for an export artifact (`uploadedByUserId` only) and must keep working untouched
(AC-10): such a row reads as a `private`, `pending`, context-less document, which is exactly what it
is — spec 008's own `users.data_export_status` governs that artifact's availability, and this spec's
routes refuse `data_export` assets outright. So **no emptiness guard and no backfill are needed for
`file_assets`**; `message_attachments` *is* empty (spec 025 left it untouched) and therefore gets the
`DO $$ … RAISE EXCEPTION` guard specs 0016–0022 use before its `NOT NULL` column is added.

### Constraints and indexes

| # | Constraint | Why |
|---|---|---|
| C-1 | `file_assets_kind_ck` in (`image`,`video`,`document`); `file_assets_visibility_ck` in (`public`,`private`); `file_assets_status_ck` in (`pending`,`scanning`,`ready`,`rejected`) | closed vocabularies at the database (AC-7) |
| C-2 | `file_assets_context_type_ck`: null, or one of the seven context values | AC-8's vocabulary |
| C-3 | `file_assets_context_pairing_ck`: `context_id is null or context_type is not null` | a context id without a type is unauthorizable |
| C-4 | `file_assets_ready_pairing_ck`: `(status = 'ready') = (ready_at is not null)` | a ready asset always has its instant |
| C-5 | `file_assets_rejected_pairing_ck`: `(status = 'rejected') = (rejection_reason is not null)` | a rejection always says why |
| C-6 | `file_assets_ready_requires_clean_ck`: `status <> 'ready' or scan_outcome = 'clean'` | **AC-4 at the database**: nothing can be `ready` without a clean scan |
| C-7 | `file_assets_ready_requires_object_ck`: `status <> 'ready' or (storage_key is not null and size_bytes is not null and mime_type is not null)` | a ready asset always has a real object behind it |
| C-8 | `file_assets_size_ck`: `size_bytes is null or size_bytes >= 0`; `file_assets_scan_attempts_ck`: `scan_attempts >= 0` | sanity |
| C-9 | `file_assets_storage_key_uq` **unique** on `storage_key` where not null | one object per asset; a replayed upload cannot collide |
| C-10 | `file_assets_owner_idempotency_uq` **unique** on `(uploaded_by_user_id, idempotency_key)` where `idempotency_key is not null` | spec 015's per-entity idempotency shape |
| C-11 | `file_assets_context_idx` on `(context_type, context_id)`; `file_assets_owner_idx` on `(uploaded_by_user_id)`; `file_assets_scan_due_idx` on `(status, scan_next_attempt_at)`; `file_assets_purge_idx` on `(deleted_at)` where `storage_deleted_at is null` | the context count check, the owner list, and the sweep's two claim paths |
| C-12 | `file_assets_terminal_trg`: a row in `ready`/`rejected` may not change `status`, `storage_key`, `mime_type`, `size_bytes`, `visibility`, `context_type` or `context_id`; only `deleted_at`, `storage_deleted_at`, `legal_hold`, `file_name` (redaction), `updated_at`, `version` may move | AC-7's terminality, enforced independently of application code (master §132.18), the same trigger idiom spec 026 used for `read_at` |
| C-13 | `message_attachments_file_asset_id_idx` | spec 003's covering-index-per-FK rule |

No `status`-history/transitions tables and no `enforce_status_transition()` trigger: `file_assets` is
not one of spec 003's five state-machine entities, and C-4/C-5/C-6/C-12 express the whole lifecycle.

### Migration

- **Name:** `0023_add_file_assets.sql` + hand-written `0023_add_file_assets_down.sql`.
  **Number determined from the repository:** `drizzle/meta/_journal.json`'s head is
  `0022_add_notifications` (spec 026, committed), so this spec is `0023`. Prompt 2 must re-read the
  journal and use head + 1 if anything lands first.
- **Guard:** `DO $$ … RAISE EXCEPTION` unless `message_attachments` is empty (its `NOT NULL` column).
  No guard on `file_assets`: every added column there is nullable or defaulted by design (above).
- **No backfill. No existing row is modified.** Spec 008's export rows keep their meaning.
- **Reversible:** yes, and **gated**: the down migration refuses if any `file_assets` row has a
  `storage_key` (i.e. a real upload exists) or any `message_attachments` row exists, because dropping
  `storage_key`/`status` would orphan stored bytes and destroy the record of what was scanned. It
  drops only what `0023` added, deletes no row, and leaves the baseline skeletons, spec 015's
  `request_attachments` and spec 008's export references intact.
- **Downtime:** none.

### Retention and privacy

- **Export (spec 008).** `generateExportPayload` gains `files: Array<{ id, kind, mimeType, sizeBytes,
  fileName, contextType, status, createdAt }>` for assets the caller uploaded — **metadata only**,
  never bytes (they are already exportable through their own authorized URLs) and never another
  party's asset. `storage_key`, `checksum_sha256`, scan internals and idempotency columns are
  **never** exported.
- **Deletion (spec 008).** Inside the existing `sweepDeletions()` — the same place spec 026 hooked,
  so `app/api/v1/cron/account-deletion-sweep/route.ts` stays untouched — a deleted account's assets
  are soft-deleted, their `file_name` redacted to spec 008's sentinel, and their bytes queued for
  purge, **except** `legal_hold` assets (evidence a later spec marks), which are retained with the
  owner already anonymized. Rows are never hard-deleted: every FK is `RESTRICT` and the linkage rows
  are another party's record.
- **Purge.** The maintenance sweep deletes bytes for assets soft-deleted more than
  `FILE_PURGE_GRACE_DAYS` (default 7) ago, for `rejected` assets immediately, and for `pending`
  assets never finalized within `FILE_UPLOAD_URL_TTL_SECONDS` × 2. `storage_deleted_at` records it.
- **Admin access** to a private asset (support/T&S reading a `message_attachment`) is audited via
  `recordAdminAuditEvent` with the correlation id, exactly as spec 025 audits conversation reads.
- **Logs** carry `fileAssetId`, `contextType`, `status`, `kind` and outcome codes — never a file
  name, storage key, signature or byte content (master §117).

---

## 5. UI states

**Scope note.** `app/components/NavShell.tsx`, `AppHeader.tsx`, `app/account/page.tsx` and
`components/index.ts` carry uncommitted in-flight design-system work. This spec therefore adds two
**self-contained, reusable** components and wires them into **no** existing page: no redesign, no
token change, no new `ui/` primitive, and the `@/components` barrel is left alone (the app component
imports `@/components/ProgressBar`, a new thin re-export file, by path).

### `app/_components/FileUpload.tsx` (new)

| State | Behaviour |
|---|---|
| **Idle/Empty** | "No attachments yet" + an explicit add-file control; allowed types and the size cap are stated **before** selection |
| **Rejected client-side** | an obviously-too-large or wrong-type file is reported instantly and **not** uploaded — the server check remains authoritative |
| **Uploading** | determinate `ProgressBar` driven by real `XMLHttpRequest.upload` progress events, with percentage text; never an indefinite spinner |
| **Finalizing** | after 100% bytes sent, the control shows "Checking file…" until `finalize` returns — the UI **never** claims completion before the server confirms (AC-5) |
| **Scanning** | an asset returned as `scanning` shows "Still checking this file" and no preview |
| **Ready** | `MediaPreview` thumbnail for an image, filename + kind chip otherwise |
| **Error** | the specific reason (type, size, scan rejection, storage unavailable); the failed file can be re-selected **without losing the other already-attached files** |

### `app/_components/MediaPreview.tsx` (new)

Renders only a `ready` asset, from `GET /files/{id}`; a private asset's URL is fetched on demand and
refreshed when it expires, never cached in `localStorage`. Non-image kinds render a labelled file
row, not a broken image. Nothing is conveyed by colour alone.

**Components:** `Alert`, `Badge`, `Button`, `Card`, `EmptyState`, `ErrorState`, `Icon`, `Skeleton`
from `@/components` plus `ProgressBar` — **all existing**. The draft's `packages/ui` `FileUpload` /
`MediaPreview` do not exist and are not created.

**Route(s):** none. These components are embedded by consuming specs (015/025/028/031) when they
adopt attachments; this spec adds no page and modifies no page.

---

## 6. Test plan

Vitest is the only runner (`npm test` → `vitest run`). There is no Playwright; `e2e/*.spec.ts` is a
Vitest pattern already configured in `vitest.config.ts` and used by five existing specs. **The
draft's `apps/api/**`, `apps/web` and `apps/web-e2e/**` paths do not exist.**

| Level | What it covers | Where |
|---|---|---|
| **Unit — validation** | kind↔MIME allowlist, per-kind size limits from env, magic-byte sniffing (including a `.jpg` that is really a PDF/executable), filename sanitisation | `lib/files/validation.test.ts` |
| **Unit — lifecycle** | the permitted transitions, terminality, `unknown` never reaching `ready`, backoff schedule and attempt ceiling | `lib/files/lifecycle.test.ts` |
| **Unit — context registry** | an unregistered context is refused; a registered one is consulted for upload and read; registration is idempotent and resettable | `lib/files/contexts/registry.test.ts` |
| **Adapter** | the local adapter round-trips bytes, `head`/`readPrefix` report actual values, `publicUrl` is null for private, and the factory **refuses a sandbox under `NODE_ENV=production`** (AC-11) | `lib/files/storage/local.test.ts` |
| **Scanner** | EICAR and the test markers map to `rejected`/`unknown`/`clean` deterministically; the sandbox refuses production | `lib/files/scanning/sandbox.test.ts` |
| **Source guard** | `lib/files/**` writes no consumer table (`requests`, `bookings`, `messages`, `payments`…), imports only the allowlisted read-only authorization helpers, and no route sets `status`/`visibility`/`owner`/`storage_key` | `lib/files/boundaries.test.ts` |
| **Integration — upload lifecycle** | upload-url → PUT → finalize → scanning → ready; declared-vs-actual size mismatch rejects and purges; `FILE_NOT_UPLOADED` when no object exists; finalize is idempotent | `lib/files/upload.integration.test.ts` |
| **Integration — idempotency** | same key + same body replays the same target; same key + different body is `409`; concurrent identical calls create one asset | `lib/files/idempotency.integration.test.ts` |
| **Integration — scanning** | `clean` → ready; `rejected` → terminal + bytes purged; `unknown` stays non-ready across retries and never becomes ready; ceiling logs `file.scan_unresolved` | `lib/files/scanning.integration.test.ts` |
| **Integration — access control** | private asset needs a signed URL; the URL is bound to its user; a leaked URL fails for another user; an expired one fails; access revoked after issue fails at the next fetch; another user's id is `404`, never `403`; wrong active mode on a message attachment is `403` | `lib/files/access.integration.test.ts` |
| **Integration — contexts** | each shipped policy's upload/read rules; reserved contexts are `422 FILE_CONTEXT_NOT_AVAILABLE` and create no row; count caps; `data_export` unreachable through these routes | `lib/files/contexts.integration.test.ts` |
| **Integration — public/CDN** | a `ready` portfolio image returns a CDN URL carrying the delivery transform; a non-ready one does not; a private asset never gets a public URL | `lib/files/public-delivery.integration.test.ts` |
| **Integration — deletion & retention** | owner-only delete; soft-deleted reads `404`; linkage rows survive; purge after the grace period; `legal_hold` retained; account deletion redacts the filename and queues purge | `lib/files/deletion.integration.test.ts` |
| **Integration — spec 008 compatibility** | the export sweep's bare insert + `store`/`retrieve` still work with this spec's adapter registered, **without any spec 008 code change** (AC-10) | `lib/files/legacy-port.integration.test.ts` |
| **Integration — sweep** | claims only due rows, `FOR UPDATE SKIP LOCKED` across overlapping runs, honours backoff, and the cron route requires the bearer secret | `lib/files/sweep.integration.test.ts` |
| **API/authorization/OpenAPI** | session on every route; CSRF on every mutation; `Idempotency-Key` required on upload-url; status/error matrix (`404`/`409 FILE_NOT_READY`/`409 FILE_REJECTED`/`422`/`503`); five routes registered and tagged `files`; the cron route absent | `lib/files/routes.integration.test.ts` |
| **Privacy** | export carries file metadata and no storage key, checksum, scan internals or another party's asset | `lib/files/privacy.integration.test.ts` |
| **Migration** | reversible on a throwaway `*_test` database; the gated down refuses once an upload exists; the baseline tables gain their columns; C-6/C-12 reject a hand-written violation; `check:schema-baseline` passes | `lib/db/migrations.integration.test.ts` (extended, as spec 026 did) |
| **Component** | progress is determinate; completion is only claimed after `finalize`; a rejected file keeps the others; scanning shows no preview; ready shows one | `app/_components/FileUpload.test.tsx`, `app/_components/MediaPreview.test.tsx` |
| **E2E (Vitest)** | a customer uploads a request attachment and sees it previewed; a stranger cannot read it with the id or a copied link | `e2e/file-upload.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `validation.test.ts::rejects a disallowed type and an oversized declared file`; `upload.integration.test.ts::an actual size over the limit rejects and purges`; `::a .jpg whose bytes are not a JPEG is rejected` |
| AC-2 | `public-delivery.integration.test.ts::a ready portfolio image returns a CDN url with the delivery transform`; `::a non-ready public asset returns no url` |
| AC-3 | `access.integration.test.ts::a private asset is reachable only through a signed url that expires`; `local.test.ts::publicUrl is null for a private object` |
| AC-4 | `scanning.integration.test.ts::rejected is terminal and purges bytes`; `::unknown never becomes ready`; `migrations::the ready-requires-clean CHECK rejects a hand-written violation` |
| AC-5 | `FileUpload.test.tsx::shows determinate progress`; `::claims completion only after finalize returns` |
| AC-6 | `access.integration.test.ts::a leaked signed url fails for another user`; `::an expired signature is refused`; `::access revoked after issue fails at the next fetch`; `::another user's id is 404, never 403` |
| AC-7 | `lifecycle.test.ts::terminal states cannot change`; `migrations::the terminal trigger rejects a status change`; `routes.integration.test.ts::no route accepts status, visibility, owner or storageKey` |
| AC-8 | `contexts.integration.test.ts::a reserved context is 422 and creates no row`; `registry.test.ts::an unregistered context is refused` |
| AC-9 | `deletion.integration.test.ts::soft delete hides the asset and keeps its linkage`; `::bytes are purged after the grace period`; `::a legal-hold asset is retained` |
| AC-10 | `legacy-port.integration.test.ts::spec 008's export sweep succeeds unchanged with this spec's adapter registered` |
| AC-11 | `local.test.ts::the factory refuses a sandbox adapter under NODE_ENV=production`; `sandbox.test.ts::the scanner refuses production`; `routes.integration.test.ts::an unavailable adapter is 503, and nothing is marked ready` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** a real vendor's malware-detection accuracy, CDN edge behaviour and
image-codec quality — no account, credential or library exists, and testing against an adapter this
repository does not have would test nothing (spec 021 §3's position, unchanged). Video transcoding
and thumbnail extraction are out of scope (§7).

---

## 7. Out of scope

- **A real object-storage, CDN or malware-scanning vendor** — this spec ships the seams, a local
  development adapter and a deterministic sandbox scanner. A later spec supplies adapters; nothing
  else changes.
- **Image/video editing** (crop, filters), **video transcoding**, thumbnail extraction and derivative
  variant storage.
- **Any consumer's rule about when a file is required** — 015/020/028/031 and the portfolio spec own
  that. This spec provides the primitive and the context registry only.
- **Attachment UI inside existing pages** — the two components ship standalone; each consuming spec
  adopts them.
- **Reserved contexts** (`booking_evidence`, `dispute_evidence`, `verification_document`) — vocabulary
  and CHECK only, deliberately unusable until 028/029/031 register a policy.
- **Audit storage and querying** — spec 039. This spec emits through spec 009's existing helper.
- **Runtime feature-flag configuration** — spec 041. Adapter selection is an environment variable.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Object storage + CDN vendor and credentials (the draft's Open #1) | Platform | **Resolved as a boundary**: `FileStorageAdapter` + a local-disk development adapter that refuses production (AC-11). No vendor is chosen, no credential invented (master §133.5–§133.7) |
| 2 | Malware scanning approach (the draft's Open #2) | Security | **Resolved as a boundary**: `FileScanner` + a deterministic sandbox (EICAR + documented markers) that refuses production. It claims no detection capability, and `unknown` never becomes `ready` |
| 3 | The draft declared `FileAsset` as a NEW table | Platform | **Resolved** (§4): `file_assets` and `message_attachments` are spec 003 skeletons; this spec ALTERS them and creates no table |
| 4 | Spec 008 already inserts bare `file_assets` rows | Platform | **Resolved** (§4/AC-10): every added column is nullable or defaulted, so spec 008's insert and port calls keep working unchanged; `data_export` assets are refused by this spec's routes |
| 5 | `context_type` could become an authorization bypass | Platform/Security | **Resolved** (§3/AC-8): a context is usable only while a policy is registered; unregistered contexts are refused at upload and can therefore never exist |
| 6 | A signed URL could outlive the authorization that justified it | Security | **Resolved** (§3/AC-6): the signature is bound to `(asset, user, expiry)` and `canRead` is re-run on every content fetch; a signature is never an authorization by itself |
| 7 | AC-2 would be untestable with no public context shipped | Product/Platform | **Resolved**: the `portfolio` context ships here with an unambiguous owner (the uploader's own provider profile) and is the one public-eligible context. The portfolio *feature* (gallery, ordering, display rules) remains its owning spec's |
| 8 | Concrete type/size/count limits are not fixed by the master spec | Product | **Bounded decision, not a blocker** (§3 "Limits"): 10 MB images / 20 MB documents / 100 MB video, JPEG-PNG-WebP-PDF-MP4, 5 per request, 5 per message, 20 per portfolio — all environment-configurable, so Product retunes without a code change. This also answers spec 015 §8 #1 |
| 9 | Spec 015's attachment limits were left open there | Product + 027 | **Resolved here** (§3 "Limits"). Spec 015 is **not edited**; enforcement lives where the columns exist |
| 10 | No image library exists in `package.json` | Platform | **Resolved honestly** (§3): the default optimizer *declines* and the delivery transform is carried on the CDN URL. No dependency is added and no resize is claimed that does not happen |
| 11 | `finalize`-time inline scanning could block a request | Platform | **Accepted**: the inline attempt is best-effort and bounded; anything unresolved falls to the sweep. A slow or failing scanner delays availability, never the response |

**No open question remains that blocks implementation.** Items 8 is a *bounded product decision*
already given a default; item 7's portfolio display rules and the reserved contexts are explicitly
deferred to their owning specs.

---

## 9. Rollout

- **Feature flag:** none — this is required infrastructure for already-committed features, and
  every context is gated by policy registration rather than a flag.
- **Environment:** eleven variables, kept in parity by `npm run check:env` —
  `FILE_STORAGE_PROVIDER` (`local`), `FILE_STORAGE_LOCAL_DIR` (OS temp dir), `FILE_SCANNER`
  (`sandbox`), `FILE_PUBLIC_CDN_BASE_URL` (unset → no public URL), `FILE_SIGNED_URL_TTL_SECONDS`
  (300), `FILE_UPLOAD_URL_TTL_SECONDS` (900), `FILE_SCAN_MAX_ATTEMPTS` (5),
  `FILE_MAX_IMAGE_BYTES` (10485760), `FILE_MAX_DOCUMENT_BYTES` (20971520), `FILE_MAX_VIDEO_BYTES`
  (104857600), `FILE_PURGE_GRACE_DAYS` (7).
- **Migration order:** `0023` ships with the code as one unit; the routes depend on its columns.
- **Cron:** `/api/v1/cron/file-maintenance-sweep` added to `vercel.json` at `*/5 * * * *`, the same
  mechanism and bearer secret as the ten existing scheduled routes.
- **Registration:** `instrumentation.ts` registers the storage adapter with spec 008's
  `registerFileAssetStorage` and the three shipped context policies — the same composition-root
  wiring specs 021–026 use.
- **Rollback — what it can and cannot mean.**
  1. **Roll the code back, not the bytes.** Reverting stops new uploads. Spec 008's port returns to
     throwing, which is exactly its documented pre-027 behaviour, so no shipped spec breaks.
  2. **Do not apply the down migration once an upload exists.** It is gated on that: dropping
     `storage_key`/`status` would orphan stored objects and destroy the record of what was scanned.
     The correct response after launch is a forward fix.
  3. **Queued work is safe to leave.** A `scanning` or purge-pending row is claimed idempotently by
     whatever code version is deployed.
  4. **A rejected file is never re-admitted.** `rejected` is terminal by trigger, not by convention.
- **Observability (master §117):** structured logs for `file.upload_requested`, `file.finalized`,
  `file.scan_completed`, `file.scan_unresolved`, `file.rejected`, `file.purged` and
  `file.storage_unavailable`, each carrying `correlationId`, `fileAssetId`, `contextType`, `kind`
  and `status` — never a file name, storage key, signature or byte. Alert on: finalize failure rate,
  scan rejection rate, unresolved scans, `503 FILE_STORAGE_UNAVAILABLE` in production (which AC-11's
  guard should make impossible), and purge backlog.
