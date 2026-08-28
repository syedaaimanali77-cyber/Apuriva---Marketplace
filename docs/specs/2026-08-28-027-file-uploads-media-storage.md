# Spec: File Uploads & Media Storage

**File:** `docs/specs/2026-08-28-027-file-uploads-media-storage.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §56, §102, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §11, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No file/media handling exists, yet requests (015), completion evidence (028),
disputes (031), messaging (025), and provider portfolios all reference attachments. Master spec
§56/§102 require object storage with CDN for public media, private signed-URL storage for
sensitive files, type/size limits, malware/security checks, and image/video optimization.

**Who is affected:** Every spec that accepts an upload; Trust & Safety reviewing evidence;
customers/providers whose private documents (verification, dispute evidence) must never leak.

**Why it matters now:** Multiple already-specified features (015 request attachments, 020
completion evidence) reference `FileAsset` as if it exists — this spec makes that real before
those flows can be fully implemented end-to-end.

**Success looks like:** A single `FileAsset` upload pipeline handles images/video/documents with
enforced limits, routes public media through CDN-optimized delivery and private/sensitive media
through signed, time-limited URLs with strict access control, and screens uploads for basic
security risks.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a file exceeding the configured type/size limit **When** uploaded **Then** it is rejected before storage with a clear error, not silently truncated or accepted |
| AC-2 | **Given** a public-eligible image (e.g. provider portfolio photo) **When** uploaded **Then** it is served via CDN with reasonable optimization (resizing/compression) |
| AC-3 | **Given** a private/sensitive file (verification document, dispute evidence) **When** accessed **Then** it is only reachable via a signed, time-limited URL, never a permanently public path |
| AC-4 | **Given** an upload **When** scanned **Then** basic malware/content-safety checks run before the file is made available to any other user |
| AC-5 | **Given** an in-progress upload **When** the user is on a slow connection **Then** upload progress is shown, and the UI never claims completion before the server confirms |
| AC-6 | **Given** a file owned by one user **When** another unauthorized user requests it **Then** access is denied server-side regardless of whether they have a guessed/leaked URL to an expired signed link |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/files/upload-url` | session | `200` `ApiResponse<{ uploadUrl, fileAssetId }>` | pre-signed direct-to-storage upload |
| `POST` | `/api/v1/files/{id}/finalize` | session (owner) | `200` `ApiResponse<FileAssetDto>` | confirms upload complete, triggers scan/optimization |
| `GET` | `/api/v1/files/{id}` | session (authorized per context) | `200` `ApiResponse<{ url }>` | returns a signed URL for private assets, CDN URL for public |
| `DELETE` | `/api/v1/files/{id}` | session (owner) | `204` | soft delete |

### Request and response types

```typescript
// packages/types/src/files.ts
export interface FileAssetDto {
  id: string;
  kind: 'image' | 'video' | 'document';
  visibility: 'public' | 'private';
  sizeBytes: number;
  status: 'pending' | 'scanning' | 'ready' | 'rejected';
  ownerId: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `FILE_TYPE_NOT_ALLOWED` | disallowed MIME type |
| `400` | `FILE_TOO_LARGE` | exceeds configured size limit |
| `422` | `SCAN_REJECTED` | failed malware/content-safety check |
| `403` | `FORBIDDEN` | unauthorized access attempt on a private asset |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `FileAsset` | new | `id uuid pk`, `owner_id uuid fk->User`, `kind text`, `visibility text`, `storage_key text`, `size_bytes integer`, `status text`, `context_type text` (request_attachment/booking_evidence/dispute_evidence/message_attachment/portfolio/export/verification_doc), `context_id uuid nullable`, `created_at`, `deleted_at timestamptz nullable` |

Every consumer spec (015, 020, 025, 031, provider portfolio) references `FileAsset` by ID rather
than duplicating storage logic.

### Migration

- **Name:** `AddFileAssetTable`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Verification documents and dispute evidence are highly sensitive — private visibility enforced
by default, access always signed/time-limited and, for admin access, audited (spec 039).
Deletion/export flows (spec 008) cover user-owned files; legally required evidence may be
retained past a user's account deletion per policy.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | upload progress bar with percentage, not an indefinite spinner |
| **Empty** | "No attachments yet" + add-file action wherever uploads are optional |
| **Error** | rejected file (type/size/scan) shows the specific reason, allows re-selection without losing other already-attached files |
| **Success** | thumbnail/preview shown once `status: ready`; never shown as available before scan/finalize completes |

**Route(s):** embedded across request creation (015), booking evidence (020), disputes (031),
messaging (025) — not a standalone route
**Shared components used/added:** `packages/ui` `FileUpload`, `MediaPreview`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | type/size validation, visibility routing logic | `apps/api/files/**/*.test.ts` |
| **Integration** | full pre-signed-upload → finalize → scan → ready lifecycle; access-control on private assets | `apps/api/files/*.integration.test.ts` |
| **Component** | upload progress UI states | `apps/web` (Testing Library) |
| **E2E** | user uploads a request attachment, sees it previewed; unauthorized user cannot access another's private evidence | `apps/web-e2e/file-upload.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/files/validation.integration.test.ts::rejects oversized/wrong-type file` |
| AC-3 | `apps/api/files/access.integration.test.ts::private asset requires signed url` |
| AC-4 | `apps/api/files/scan.integration.test.ts::rejects unsafe content before availability` |
| AC-6 | `apps/api/files/access.integration.test.ts::denies unauthorized access even with stale link` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The specific malware-scanning vendor's detection accuracy
(external dependency; only the integration contract is tested).

---

## 7. Out of scope

- Any specific consumer's business rules about *when* an attachment is required (each owning
  spec, e.g. 015, 020, 031, defines that) — this spec only provides the storage primitive.
- Image/video editing features (crop, filters) — not part of MVP.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Object storage + CDN vendor selection and credential availability | — | Open — sandbox/local-disk adapter required for dev/test per master spec §133.7 |
| 2 | Malware-scanning approach (third-party API vs. basic heuristic for MVP) | Security | Open |

---

## 9. Rollout

- **Feature flag:** none — required infrastructure for multiple already-committed features.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; stored files remain accessible via existing storage keys.
- **Observability:** upload failure rate, scan-rejection rate, and storage cost/usage monitored
  (master spec §117).
