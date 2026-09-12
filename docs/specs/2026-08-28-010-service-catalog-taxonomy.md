# Spec: Service Catalog & Taxonomy

**File:** `docs/specs/2026-08-28-010-service-catalog-taxonomy.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §14, §18, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No service catalog exists. Master spec §14 requires 8 seed categories, each with an
optional subcategory layer and a set of services, fully admin-controlled, with AI able to
suggest additions but never unilaterally publish them. The 8 categories are the initial MVP
seed set required at launch, not a permanent ceiling — Content/Marketplace admins may create
additional categories later through the same catalog management endpoints as any other
category.

**Who is affected:** Every browsing/search/request spec downstream (011, 013, 015) that needs a
real taxonomy to search, filter, and attach request fields to; the Content/Marketplace admin
role (spec 009) who owns catalog changes.

**Why it matters now:** It's the first Milestone-3 dependency — nothing about search, category
pages, or request creation is buildable against fake/hardcoded categories.

**Success looks like:** The 8 MVP categories exist with real subcategories/services seeded, an
admin can create/edit/retire a category, subcategory, or service, and AI-suggested catalog
changes land in a review queue rather than going live directly.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the seed migration **When** it runs (including re-runs on redeploy) **Then** exactly the 8 MVP categories from master spec §14 exist with no duplicates, each with zero or more subcategories and one or more services; the 8 categories are the initial seed set, not a cap — admins may add more afterward |
| AC-2 | **Given** a Content/Marketplace admin **When** they create/edit/retire a category, subcategory, or service **Then** the change is validated (required fields, taxonomy relationships, slug uniqueness), subject to lifecycle transition rules (§4 Lifecycle), versioned (§3 Versioning), audited (§4 Retention and privacy), and customer-facing browsing reflects it subject to the cache/propagation rule (§5) — never silently applied past validation |
| AC-3 | **Given** an AI-suggested category, subcategory, or service (from spec 034's AI assistant) **When** submitted **Then** it is persisted as a `CatalogSuggestion` in `pending_review` status and never itself publishes or modifies any catalog entity until an authorized admin explicitly approves it |
| AC-4 | **Given** a category or subcategory with active (non-retired) services attached to it **When** an admin attempts to retire it **Then** the system blocks the retirement or requires explicit reassignment of those services to a valid active taxonomy path first, never silently orphaning services |
| AC-5 | **Given** any unauthenticated or authenticated non-admin caller **When** reading the catalog **Then** only `published` entries are returned — `draft`, `pending_review`, and `retired` entries are excluded, category detail exposes only published/active child taxonomy, and service detail only resolves for a published service |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/categories` | none | `200` `ApiResponse<CategoryDto[]>` | published only |
| `GET` | `/api/v1/categories/{id}` | none | `200` `ApiResponse<CategoryDto>` | includes only published subcategories + services |
| `GET` | `/api/v1/services/{id}` | none | `200` `ApiResponse<ServiceDto>` | `404` unless the service is `published` |
| `GET` | `/api/v1/admin/categories` | admin (Content/Marketplace) | `200` `ApiResponse<CategoryDto[]>` | all statuses, for catalog management |
| `GET` | `/api/v1/admin/categories/{id}` | admin (Content/Marketplace) | `200` `ApiResponse<CategoryDto>` | any status |
| `POST` | `/api/v1/admin/categories` | admin (Content/Marketplace) | `201` `ApiResponse<CategoryDto>` | validates required fields + slug uniqueness |
| `PATCH` | `/api/v1/admin/categories/{id}` | admin (Content/Marketplace) | `200` `ApiResponse<CategoryDto>` | optimistic concurrency via `version` (see Versioning, below) |
| `POST` | `/api/v1/admin/categories/{id}/retire` | admin (Content/Marketplace) | `200` `ApiResponse<CategoryDto>` | `422 CATEGORY_HAS_ACTIVE_SERVICES` unless reassigned first |
| `GET` | `/api/v1/admin/categories/{categoryId}/subcategories` | admin (Content/Marketplace) | `200` `ApiResponse<SubcategoryDto[]>` | all statuses under that category |
| `POST` | `/api/v1/admin/categories/{categoryId}/subcategories` | admin (Content/Marketplace) | `201` `ApiResponse<SubcategoryDto>` | parent category must be active |
| `GET` | `/api/v1/admin/subcategories/{id}` | admin (Content/Marketplace) | `200` `ApiResponse<SubcategoryDto>` | any status |
| `PATCH` | `/api/v1/admin/subcategories/{id}` | admin (Content/Marketplace) | `200` `ApiResponse<SubcategoryDto>` | optimistic concurrency via `version` (see Versioning, below) |
| `POST` | `/api/v1/admin/subcategories/{id}/retire` | admin (Content/Marketplace) | `200` `ApiResponse<SubcategoryDto>` | `422 SUBCATEGORY_HAS_ACTIVE_SERVICES` unless reassigned first |
| `GET` | `/api/v1/admin/services/{id}` | admin (Content/Marketplace) | `200` `ApiResponse<ServiceDto>` | any status |
| `POST` | `/api/v1/admin/services` | admin (Content/Marketplace) | `201` `ApiResponse<ServiceDto>` | `422 INVALID_TAXONOMY_PATH` if category/subcategory invalid or inactive |
| `PATCH` | `/api/v1/admin/services/{id}` | admin (Content/Marketplace) | `200` `ApiResponse<ServiceDto>` | optimistic concurrency via `version` (see Versioning, below) |
| `POST` | `/api/v1/admin/services/{id}/retire` | admin (Content/Marketplace) | `200` `ApiResponse<ServiceDto>` | soft state change, not delete |
| `POST` | `/api/v1/admin/catalog/suggestions` | authenticated (spec 034 AI assistant, via spec 035's MCP tool pipeline) | `201` `ApiResponse<CatalogSuggestionDto>` | always created `pending_review`; never mutates a catalog entity |
| `GET` | `/api/v1/admin/catalog/pending-review` | admin (Content/Marketplace) | `200` `PagedResponse<CatalogSuggestionDto>` | suggestions currently `pending_review` |
| `POST` | `/api/v1/admin/catalog/pending-review/{id}/approve` | admin (Content/Marketplace) | `200` `ApiResponse<CatalogSuggestionDto>` | creates/updates the resulting entity; `409 SUGGESTION_ALREADY_REVIEWED` if not `pending_review` |
| `POST` | `/api/v1/admin/catalog/pending-review/{id}/reject` | admin (Content/Marketplace) | `200` `ApiResponse<CatalogSuggestionDto>` | records reviewer/time; publishes nothing; `409 SUGGESTION_ALREADY_REVIEWED` if not `pending_review` |

All `/api/v1/admin/**` endpoints above resolve `(resource, action)` permission checks server-side
through spec 009 §3.1's framework, scoped to the Content/Marketplace admin role (e.g.
`resource: 'catalog.category' | 'catalog.subcategory' | 'catalog.service' | 'catalog.suggestion'`,
`action: 'create' | 'edit' | 'retire' | 'approve' | 'reject'`) — server-side authorization is
authoritative, and any frontend role/menu check is UX convenience only, never the security
boundary. `POST /api/v1/admin/catalog/suggestions` is the one exception: it is called by spec
034's AI assistant through spec 035's MCP tool pipeline (its own 8-point authorization check,
not a Content/Marketplace permission grant), since submitting a suggestion never mutates the
catalog. This spec does not define a new permission system — it declares permissions under spec
009's existing one.

### Request and response types

```typescript
// lib/types/catalog.ts

/** Catalog entity lifecycle (Category, Subcategory, Service) — see Lifecycle, §4. */
export type CatalogEntityStatus = 'draft' | 'published' | 'pending_review' | 'retired';

/** AI `CatalogSuggestion` lifecycle — deliberately separate from `CatalogEntityStatus` even
 * though both use the term `pending_review`: a suggestion is a proposal that may or may not
 * ever become a catalog entity, never a catalog entity itself (see Lifecycle, §4). */
export type CatalogSuggestionStatus = 'pending_review' | 'approved' | 'rejected';

export type PricingModel = 'fixed' | 'package' | 'hourly' | 'quote' | 'custom';

export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  status: CatalogEntityStatus;
  sortOrder: number;
  subcategories: SubcategoryDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubcategoryDto {
  id: string;
  categoryId: string;
  name: string;
  slug: string;
  status: CatalogEntityStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDto {
  id: string;
  categoryId: string;
  subcategoryId: string | null;
  name: string;
  slug: string;
  pricingModel: PricingModel;
  status: CatalogEntityStatus;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Every mutating `POST`/`PATCH` body carries the writable fields of the corresponding Dto; a
 * `PATCH` additionally carries `expectedVersion: number` (see Versioning, below) — supplying it and having it not
 * match the row's current `version` returns `409 CONFLICT`, never a silent overwrite. */

export interface CatalogSuggestionDto {
  id: string;
  entityType: 'category' | 'subcategory' | 'service';
  proposedName: string;
  proposedSlug: string;
  categoryId: string | null;
  subcategoryId: string | null;
  pricingModel: PricingModel | null;
  metadata: Record<string, unknown>;
  rationale: string | null;
  source: string;
  status: CatalogSuggestionStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  resultingEntityId: string | null;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | a required field is missing/malformed on a category, subcategory, service, or suggestion mutation |
| `403` | `FORBIDDEN` | caller lacks the Content/Marketplace admin permission for this `(resource, action)` (spec 009) |
| `404` | `NOT_FOUND` | the referenced category, subcategory, service, or suggestion does not exist |
| `409` | `CONFLICT` | `expectedVersion` supplied on a `PATCH` does not match the row's current `version` (Versioning, below), or the requested slug already exists in the scope it must be unique within (Slug rules, below) |
| `409` | `SUGGESTION_ALREADY_REVIEWED` | approving/rejecting a `CatalogSuggestion` that is no longer `pending_review` |
| `422` | `CATEGORY_HAS_ACTIVE_SERVICES` | retiring a category with active (non-retired) services attached, without reassignment |
| `422` | `SUBCATEGORY_HAS_ACTIVE_SERVICES` | retiring a subcategory with active (non-retired) services attached, without reassignment |
| `422` | `INVALID_TAXONOMY_PATH` | a service/subcategory references a category or subcategory that doesn't exist, doesn't belong to the stated parent, or isn't active (Taxonomy integrity, §4) |
| `422` | `INVALID_LIFECYCLE_TRANSITION` | the requested status change isn't a valid transition for that entity (Lifecycle, §4) |

### Versioning

Category, Subcategory, and Service each carry `version` per spec 003 §AC-6's baseline optimistic
concurrency convention. A `PATCH` may supply `expectedVersion`; if supplied and it does not match
the row's current `version`, the update is rejected with `409 CONFLICT` — never a silent
last-write-wins overwrite. A successful edit increments `version` by 1. This is consistent across
all three entity types; no entity has its own bespoke concurrency rule.

### Slug rules

Every `slug` is normalized (lowercase, ASCII, `-`-separated) before the uniqueness check. Scope:

- **Category** slugs are unique across all categories.
- **Subcategory** slugs are unique within their parent category (not globally).
- **Service** slugs are unique within the applicable service/catalog scope (i.e. no two services
  share a slug).

A slug collision within its scope returns `409 CONFLICT` — the same code as a version mismatch,
distinguished by the response's message; a slug collision is a `409`, not `400`, since the input
itself is well-formed and the conflict is with existing state, not a malformed request.

### AI suggestion review

`POST .../suggestions` only ever creates a `CatalogSuggestion` row in `pending_review` — it never
creates, updates, or publishes a Category, Subcategory, or Service (AC-3). Only
`POST .../approve` and `POST .../reject`, both Content/Marketplace admin-authorized, change that:

- **Approve** first re-checks the suggestion is still `pending_review` (`409
  SUGGESTION_ALREADY_REVIEWED` otherwise), then validates the proposed name/slug/taxonomy exactly
  as a normal create/edit would (`400 VALIDATION_ERROR` / `422 INVALID_TAXONOMY_PATH` on failure,
  leaving the suggestion untouched), then creates (or, for an edit-suggestion, updates) the
  resulting Category/Subcategory/Service with status `pending_review` — not `published` —, then
  records `reviewedAt`, `reviewedBy`, and `resultingEntityId` on the suggestion and sets its
  status to `approved`. Approval alone never makes the entity customer-visible: it starts
  `pending_review`, exactly the case the Lifecycle section (§4) already describes ("the resulting
  entity of an approved AI suggestion the admin has not yet explicitly published"). Making it
  customer-visible requires a Content/Marketplace admin to separately transition it
  `pending_review → published` through the normal category/subcategory/service `PATCH` endpoint
  (Lifecycle, §4) — the same authorized-publication path any admin-authored entry uses. The AI
  assistant has no path to that transition; only an admin's explicit publish action does it.
- **Reject** first re-checks the suggestion is still `pending_review` (`409
  SUGGESTION_ALREADY_REVIEWED` otherwise), then records `reviewedAt`/`reviewedBy` and sets status
  to `rejected`. No catalog entity is created, and the suggestion stays unpublished permanently —
  `rejected`, like `approved`, is terminal.
- The AI assistant itself never calls approve/reject and never has a path to publish directly;
  only an authorized admin's explicit decision does.

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Category` | new | `id uuid pk`, `name text`, `slug text unique`, `status text`, `sort_order integer`, `version integer`, `created_at`, `updated_at` |
| `Subcategory` | new | `id uuid pk`, `category_id uuid fk->Category`, `name text`, `slug text` (unique within `category_id`), `status text`, `version integer`, `created_at`, `updated_at` |
| `Service` | new | `id uuid pk`, `category_id uuid fk->Category`, `subcategory_id uuid fk->Subcategory nullable`, `name text`, `slug text` (unique within scope, see Slug rules, §3), `pricing_model text`, `status text`, `metadata jsonb` (service-specific variable data, e.g. typical duration ranges), `version integer`, `created_at`, `updated_at` |
| `CatalogSuggestion` | new | `id uuid pk`, `entity_type text` (`category`\|`subcategory`\|`service`), `proposed_name text`, `proposed_slug text`, `category_id uuid fk->Category nullable` (set when `entity_type` is `subcategory`/`service`), `subcategory_id uuid fk->Subcategory nullable` (set when applicable to `service`), `pricing_model text nullable` (set when `entity_type` is `service`), `metadata jsonb`, `rationale text nullable`, `source text` (e.g. `ai_assistant`), `status text`, `created_at`, `reviewed_at timestamptz nullable`, `reviewed_by uuid fk->User nullable`, `resulting_entity_id uuid nullable` (the created/updated Category/Subcategory/Service id once approved) |

`ServiceField`, `ServiceRequirement`, `ServiceFAQ`, `ServicePackage` are owned by spec 011 (they
extend `Service`, not duplicated here); spec 015's `RequestFieldValue` separately captures a
customer's answer to a `ServiceField` at request-creation time.

### Taxonomy integrity

- Every `Service` must reference an active (`status = 'published'`) `Category`; `category_id`
  pointing at a missing or non-active category returns `422 INVALID_TAXONOMY_PATH`.
- If `subcategory_id` is supplied on a `Service`, that `Subcategory` must belong to the
  referenced `category_id` and be active; a mismatched parent or an inactive/missing subcategory
  returns `422 INVALID_TAXONOMY_PATH`.
- A retired `Category` or `Subcategory` cannot be assigned to a new or edited `Service` — the
  same `422 INVALID_TAXONOMY_PATH` applies.
- These checks run on every create/edit, not only at retirement time, so the system never
  silently orphans a `Service` against a taxonomy path that no longer resolves.

### Lifecycle

`CatalogEntityStatus` (Category, Subcategory, Service) — `draft`, `published`, `pending_review`,
`retired`:

- **`draft`** — admin-created/edited, not yet customer-visible.
- **`published`** — customer-visible per AC-5 (subject to the parent taxonomy also being
  `published`/active).
- **`pending_review`** — not customer-visible; an admin-authored entry the admin has marked for
  a colleague's review before publishing, or the resulting entity of an approved AI suggestion
  the admin has not yet explicitly published. Functionally equivalent to `draft` for visibility.
- **`retired`** — soft-retired, not customer-visible, not physical deletion. Terminal — this spec
  defines no restoration path; a later spec may add one explicitly.

Valid transitions: `draft → published`, `draft → pending_review`, `pending_review → published`,
and `draft`/`published`/`pending_review` → `retired`. Any other requested transition (including
any transition out of `retired`) returns `422 INVALID_LIFECYCLE_TRANSITION`.

Admin-created/edited entries use no separate publication workflow beyond the Content/Marketplace
admin authorization this spec and spec 009 already provide — an admin's create/edit call sets the
entity's status directly (e.g. `published` or `draft`, per the request body); this spec does not
invent an additional approval-to-publish step for admin-authored content.

`CatalogSuggestionStatus` (`CatalogSuggestion` only) — `pending_review`, `approved`, `rejected` —
is a separate lifecycle (AC-3; see AI suggestion review, §3) that never itself represents
a catalog entity's state: a `CatalogSuggestion` in `pending_review` has no corresponding
Category, Subcategory, or Service row yet, so it is never customer-visible by construction, not
merely by status filtering. `approved`/`rejected` are themselves terminal for that suggestion —
an already-reviewed suggestion cannot be reviewed again (`409 SUGGESTION_ALREADY_REVIEWED`).

### Retirement and reassignment

A `Category` cannot be retired (`POST .../retire`) while any active (non-`retired`) `Service`
still references it, directly or via one of its subcategories — the request is rejected with
`422 CATEGORY_HAS_ACTIVE_SERVICES`. A `Subcategory` cannot be retired while any active `Service`
still references it — rejected with `422 SUBCATEGORY_HAS_ACTIVE_SERVICES`. In both cases,
retirement succeeds only once every attached active `Service` has first been reassigned (via a
normal service `PATCH`) to a different, valid, active taxonomy path (Taxonomy integrity, above)
or itself retired — the retirement endpoint never cascades a retirement onto attached services
and never leaves a `Service` pointing at a retired parent. This is the same rule for both
`Category` and `Subcategory`, applied consistently.

### Migration

- **Name:** `AddCatalogTables`
- **Reversible:** yes
- **Backfill required:** yes — seed the 8 categories + representative subcategories/services
  (small, fixed dataset; runtime negligible). Seeding is idempotent: it upserts by the unique
  category `slug` (`Category.slug unique`, see Slug rules, §3), so re-running the
  migration/redeploy never creates duplicate rows.
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No personal data. Optimistic-concurrency versioning follows spec 003 §AC-6's baseline
(`UPDATE ... SET version = version + 1 WHERE id = $1 AND version = $2`); see Versioning (§3) for
this spec's client-facing `expectedVersion`/`409 CONFLICT` contract.

Every catalog mutation (category/subcategory/service create/edit/retire) and every AI
suggestion review (approve/reject) emits audit event data identifying: the actor, the actor's
role(s), the action, the target entity, reason/context when supplied, the relevant
version/state transition, and — for a suggestion review — the approval/review outcome
(`reviewedAt`/`reviewedBy`/`resultingEntityId`). Spec 010 emits this data; spec 039 owns
audit-log storage, retention, and admin audit access — this spec does not stand up a separate
audit-log persistence system.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | category grid/list skeleton |
| **Empty** | admin catalog editor shows "No services in this category yet" + "Add service" action; AI review queue shows "No suggestions pending review" |
| **Error** | admin save failure preserves entered form data, shows validation errors inline (including the specific field/reason, not a generic message) |
| **Success** | toast confirmation on publish/retire/approve/reject |

**Cache/propagation rule:** a successful catalog mutation (create/edit/retire, or an AI
suggestion approval) invalidates or refreshes whatever cache layer sits in front of catalog
reads. This spec does not promise literal zero-latency propagation to every caller; it promises
that customer-facing reads do not remain stale beyond that cache's existing
invalidation/TTL contract. No dedicated catalog cache exists elsewhere in the architecture today
— absent one, reads go straight to the database and are always current. The exact TTL/caching
implementation, if one is introduced later (e.g. CDN/edge caching), is a deployment concern
outside this spec.

**Route(s):** `app/explore` (customer-facing browse), `app/admin/marketplace/catalog` — the admin
route covers category, subcategory, and service management plus the AI suggestion review queue
(list, approve, reject) as states of the same catalog editor, not a separate page.
**Shared components used/added:** `components` `Card`, `Table`, `Form` primitives — no new design
system and no visual redesign; this spec only adds catalog-specific screens built from existing
shared components.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | slug normalization/uniqueness scoping, lifecycle-transition validator, taxonomy-path validator, version/concurrency check | `app/api/v1/catalog/**/*.test.ts` |
| **Integration** | seed idempotency; category/subcategory/service CRUD + retirement; retirement-reassignment blocking; slug collisions; taxonomy validation; version conflicts; guest/public filtering; suggestion create → approve/reject; duplicate-review rejection; unauthorized admin mutation rejection; audit event payload | `app/api/v1/catalog/*.integration.test.ts` |
| **Component** | admin catalog editor states (loading/empty/error/success), AI review queue states | the application (Testing Library) |
| **E2E** | admin creates a service, it appears in guest browse; category retirement blocked then succeeds after reassignment | `e2e/catalog.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/catalog/seed.integration.test.ts::seeds exactly the 8 MVP categories with no duplicates` |
| AC-1 | `app/api/v1/catalog/seed.integration.test.ts::re-running the seed migration is idempotent (no duplicate rows)` |
| AC-2 | `app/api/v1/catalog/category.integration.test.ts::admin creates/edits/retires a category — validated, versioned, audited` |
| AC-2 | `app/api/v1/catalog/subcategory.integration.test.ts::admin creates/edits/retires a subcategory — validated, versioned, audited` |
| AC-2 | `app/api/v1/catalog/service.integration.test.ts::admin creates/edits/retires a service — validated, versioned, audited` |
| AC-2 | `app/api/v1/catalog/slug.test.ts::slug uniqueness enforced per scope (category global, subcategory per-category, service per-scope)` |
| AC-2 | `app/api/v1/catalog/taxonomy.integration.test.ts::create/edit rejects an invalid or retired taxonomy path with 422 INVALID_TAXONOMY_PATH` |
| AC-2 | `app/api/v1/catalog/version.test.ts::a stale expectedVersion on PATCH returns 409 CONFLICT, never a silent overwrite` |
| AC-2 | `app/api/v1/catalog/audit.integration.test.ts::every mutation emits actor/role/action/target/version audit event data` |
| AC-2 | `app/api/v1/catalog/authz.integration.test.ts::a non-Content/Marketplace admin's mutation is rejected 403 FORBIDDEN regardless of frontend state` |
| AC-3 | `app/api/v1/catalog/suggestions.integration.test.ts::creating a suggestion never creates/publishes a catalog entity` |
| AC-3 | `app/api/v1/catalog/suggestions.integration.test.ts::approve validates proposed data, creates the entity as pending_review (not published), records reviewedAt/reviewedBy/resultingEntityId` |
| AC-3 | `app/api/v1/catalog/suggestions.integration.test.ts::an approved suggestion's resulting entity only becomes customer-visible after an admin separately publishes it via PATCH` |
| AC-3 | `app/api/v1/catalog/suggestions.integration.test.ts::reject records reviewer/time and leaves nothing published` |
| AC-3 | `app/api/v1/catalog/suggestions.integration.test.ts::reviewing an already-reviewed suggestion returns 409 SUGGESTION_ALREADY_REVIEWED` |
| AC-4 | `app/api/v1/catalog/retire.integration.test.ts::blocks retiring a category with active services — 422 CATEGORY_HAS_ACTIVE_SERVICES` |
| AC-4 | `app/api/v1/catalog/retire.integration.test.ts::blocks retiring a subcategory with active services — 422 SUBCATEGORY_HAS_ACTIVE_SERVICES` |
| AC-4 | `app/api/v1/catalog/retire.integration.test.ts::retirement succeeds once affected services are reassigned to a valid active taxonomy path` |
| AC-4 | `app/api/v1/catalog/lifecycle.test.ts::an invalid status transition (e.g. retired → published) returns 422 INVALID_LIFECYCLE_TRANSITION` |
| AC-5 | `app/api/v1/catalog/read.integration.test.ts::guest/non-admin sees only published categories/services, never draft/pending_review/retired` |
| AC-5 | `app/api/v1/catalog/read.integration.test.ts::category detail exposes only published child subcategories/services` |
| — | `e2e/catalog.spec.ts::admin-created service appears in guest browse after publish, and cache/propagation behavior is observable where testable` |

**Coverage:** ≥80% on new/changed code.

**Not covered, deliberately:** Service-specific structured fields, requirements, FAQs, and
packages (spec 011); `RequestFieldValue` capture at request-creation time (spec 015); AI model
generation/suggestion-authoring behavior itself (spec 034) — this spec only tests suggestion
intake/review.

---

## 7. Out of scope

- Category/service detail page rendering, and `ServiceField`/`ServiceRequirement`/`ServiceFAQ`/
  `ServicePackage` themselves (spec 011).
- Pricing display/behavior logic beyond the `pricingModel` enum on `Service` — this spec defines
  and stores the enum only; presentation and any pricing behavior beyond it are spec 011's and
  master spec §16's concern.
- `RequestFieldValue` — a customer's captured answer to a `ServiceField` at request-creation time
  (spec 015); this spec owns `ServiceField`'s catalog-side definition only via spec 011's data,
  not its request-time capture.
- Downstream marketplace workflows built on the catalog (search/discovery ranking, request
  creation, offers, bookings) — each owned by its own spec (013, 015, and onward).
- Audit-log persistence, retention, and admin audit access — spec 010 emits audit event data;
  spec 039 owns storage and access.
- AI model generation/authoring behavior — how spec 034's AI assistant decides what to suggest is
  spec 034's concern; spec 010 owns only suggestion intake (`CatalogSuggestion`) and admin
  review (approve/reject).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact seed subcategories/services per category — master spec §14 names the 8 categories exactly but does not prescribe every representative subcategory/service within them | Product | Open — an approved representative seed dataset is required before/with implementation; the 8 category names themselves are fixed by master spec §14 and are not part of this open question |
| 2 | Cache TTL for public catalog reads (CDN/edge caching vs. always-fresh) | — | Open — no dedicated catalog cache exists elsewhere in the architecture today; the invalidate-on-mutation rule (§5) holds regardless of the answer, and the exact TTL is an implementation/deployment decision, not a spec010 blocker |

---

## 9. Rollout

- **Feature flag:** none — catalog is core, not optional.
- **Migration order:** schema + seed data ships together.
- **Rollback:** revert deploy; catalog data itself is not destroyed by a code rollback.
- **Observability:** catalog edit volume and pending-review queue depth tracked (spec 040).
