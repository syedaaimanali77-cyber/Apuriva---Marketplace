# Spec: Service Catalog & Taxonomy

**File:** `docs/specs/2026-08-28-010-service-catalog-taxonomy.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §14, §18, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No service catalog exists. Master spec §14 requires 8 seed categories, each with an
optional subcategory layer and a set of services, fully admin-controlled, with AI able to
suggest additions but never unilaterally publish them.

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
| AC-1 | **Given** the seed data **When** the catalog is queried **Then** exactly the 8 MVP categories from master spec §14 exist, each with zero or more subcategories and one or more services |
| AC-2 | **Given** a Content/Marketplace admin **When** they create/edit/retire a category, subcategory, or service **Then** the change is validated, versioned, and immediately reflected to customer-facing browsing |
| AC-3 | **Given** an AI-suggested category or service (from spec 034's AI assistant) **When** submitted **Then** it lands in a `pending_review` state and is never customer-visible until an admin approves it |
| AC-4 | **Given** a service with an existing taxonomy path **When** an admin attempts to retire its parent category **Then** the system blocks or requires explicit reassignment, never silently orphaning services |
| AC-5 | **Given** any unauthenticated or authenticated non-admin caller **When** reading the catalog **Then** only published (not `pending_review` or retired) entries are returned |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/categories` | none | `200` `ApiResponse<CategoryDto[]>` | published only |
| `GET` | `/api/v1/categories/{id}` | none | `200` `ApiResponse<CategoryDto>` | includes subcategories + services |
| `GET` | `/api/v1/services/{id}` | none | `200` `ApiResponse<ServiceDto>` | |
| `POST` | `/api/v1/admin/categories` | admin (Content/Marketplace) | `201` | |
| `PATCH` | `/api/v1/admin/categories/{id}` | admin (Content/Marketplace) | `200` | optimistic concurrency via `version` |
| `POST` | `/api/v1/admin/services` | admin (Content/Marketplace) | `201` | |
| `POST` | `/api/v1/admin/services/{id}/retire` | admin (Content/Marketplace) | `200` | soft state change, not delete |
| `GET` | `/api/v1/admin/catalog/pending-review` | admin (Content/Marketplace) | `200` `PagedResponse<CatalogSuggestionDto>` | AI-suggested entries |
| `POST` | `/api/v1/admin/catalog/pending-review/{id}/approve` | admin (Content/Marketplace) | `200` | publishes the suggestion |

### Request and response types

```typescript
// packages/types/src/catalog.ts
export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  subcategories: SubcategoryDto[];
  status: 'published' | 'pending_review' | 'retired';
}

export interface ServiceDto {
  id: string;
  categoryId: string;
  subcategoryId: string | null;
  name: string;
  slug: string;
  pricingModel: 'fixed' | 'package' | 'hourly' | 'quote' | 'custom';
  status: 'published' | 'pending_review' | 'retired';
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `CATEGORY_HAS_ACTIVE_SERVICES` | retiring a category with non-retired services attached |
| `409` | `CONFLICT` | `version` mismatch on concurrent admin edit |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Category` | new | `id uuid pk`, `name text`, `slug text unique`, `status text`, `sort_order integer`, `created_at`, `updated_at`, `version` |
| `Subcategory` | new | `id uuid pk`, `category_id uuid fk->Category`, `name text`, `slug text`, `status text` |
| `Service` | new | `id uuid pk`, `category_id uuid fk->Category`, `subcategory_id uuid fk->Subcategory nullable`, `name text`, `slug text`, `pricing_model text`, `status text`, `metadata jsonb` (service-specific variable data, e.g. typical duration ranges) |

`ServiceField`, `ServiceRequirement`, `ServiceFAQ`, `ServicePackage` are owned by spec 011/012
(they extend `Service`, not duplicated here).

### Migration

- **Name:** `AddCatalogTables`
- **Reversible:** yes
- **Backfill required:** yes — seed the 8 categories + representative subcategories/services
  (small, fixed dataset; runtime negligible)
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No personal data. Catalog change history retained for audit (spec 039) — every admin edit is an
audited action.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | category grid/list skeleton |
| **Empty** | admin catalog editor shows "No services in this category yet" + "Add service" action |
| **Error** | admin save failure preserves entered form data, shows validation errors inline |
| **Success** | toast confirmation on publish/retire; customer-facing catalog reflects change without cache staleness beyond a documented TTL |

**Route(s):** `apps/web/app/explore` (customer-facing browse), `apps/web/app/admin/marketplace/catalog`
**Shared components used/added:** `packages/ui` `Card`, `Table`, `Form` primitives

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | slug generation/uniqueness, retirement-blocking rule | `apps/api/catalog/**/*.test.ts` |
| **Integration** | full CRUD lifecycle, pending-review approval flow, guest read-only access | `apps/api/catalog/*.integration.test.ts` |
| **Component** | admin catalog editor states | `apps/web` (Testing Library) |
| **E2E** | admin creates a service, it appears in guest browse | `apps/web-e2e/catalog.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/catalog/seed.integration.test.ts::seeds 8 categories` |
| AC-3 | `apps/api/catalog/pending-review.integration.test.ts::ai suggestion not visible until approved` |
| AC-4 | `apps/api/catalog/retire.integration.test.ts::blocks retiring category with active services` |
| AC-5 | `apps/api/catalog/read.integration.test.ts::guest sees only published` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Service-specific structured fields and FAQs (spec 011).

---

## 7. Out of scope

- Category/service detail page rendering (spec 011).
- Pricing display logic beyond the `pricingModel` enum (spec 011, master spec §16).
- Service-specific request form fields (spec 012).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact seed subcategories/services per category — master spec names the 8 categories but not the full seed list | Product | Open — draft a representative seed list before implementation |
| 2 | Cache TTL for public catalog reads (CDN/edge caching vs. always-fresh) | — | Open |

---

## 9. Rollout

- **Feature flag:** none — catalog is core, not optional.
- **Migration order:** schema + seed data ships together.
- **Rollback:** revert deploy; catalog data itself is not destroyed by a code rollback.
- **Observability:** catalog edit volume and pending-review queue depth tracked (spec 040).
