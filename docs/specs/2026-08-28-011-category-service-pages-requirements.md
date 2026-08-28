# Spec: Category & Service Pages + Requirements

**File:** `docs/specs/2026-08-28-011-category-service-pages-requirements.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §15–§17, §26, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 010 provides raw catalog data but no presentation layer or structured-field
model. Master spec §15–§16 require rich category and service pages (not bare lists), and §17
requires each service to define required/optional fields, media requirements, and validation
that both the manual request form and the AI conversational flow must honor identically.

**Who is affected:** Customers browsing categories/services; providers whose services must
surface correctly; the request-creation flow (spec 015) and AI assistant (spec 034), both of
which read the same field definitions.

**Why it matters now:** Request creation (015) cannot be built until service-specific field
definitions exist and are queryable.

**Success looks like:** Category and service detail pages render all the content types listed
in master spec §15–§16; every service's required/optional fields are defined once and enforced
identically whether filled via form or AI conversation.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a category page **When** rendered **Then** it includes header, popular services, service-specific search entry, recommended providers, nearby availability, relevant filters, and an AI-assist entry point — never a bare list |
| AC-2 | **Given** a service page **When** rendered **Then** pricing is displayed per its `pricingModel` (fixed → exact price, package → starting price, variable → range, quote → "get offers", hourly → hourly rate) |
| AC-3 | **Given** a service's required fields **When** a request is submitted (manually or via AI, spec 015/034) without them **Then** submission is rejected with the specific missing fields named |
| AC-4 | **Given** a service with recommended-but-optional media **When** viewed **Then** the UI explains why the media helps, without blocking submission if omitted |
| AC-5 | **Given** an official service FAQ **When** AI drafts a suggested FAQ answer **Then** it is stored as a suggestion and never shown to customers as official until an admin publishes it |
| AC-6 | **Given** a provider adding their own service-specific FAQ **When** published **Then** it is visibly distinguished from official/admin FAQs |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/categories/{id}/page` | none | `200` `ApiResponse<CategoryPageDto>` | aggregated page data |
| `GET` | `/api/v1/services/{id}/page` | none | `200` `ApiResponse<ServicePageDto>` | includes fields, FAQs, packages, pricing |
| `GET` | `/api/v1/services/{id}/fields` | none | `200` `ApiResponse<ServiceFieldDto[]>` | consumed identically by manual form and AI (spec 034) |
| `POST` | `/api/v1/admin/services/{id}/fields` | admin (Content/Marketplace) | `201` | |
| `POST` | `/api/v1/admin/services/{id}/faqs` | admin (Content/Marketplace) | `201` | official FAQ |
| `POST` | `/api/v1/providers/me/services/{id}/faqs` | session (provider, ownership-checked) | `201` | provider-owned FAQ |
| `POST` | `/api/v1/admin/services/{id}/faqs/ai-suggestions/{suggestionId}/approve` | admin (Content/Marketplace) | `200` | publishes AI-drafted FAQ |

### Request and response types

```typescript
// packages/types/src/service-page.ts
export interface ServiceFieldDto {
  id: string;
  serviceId: string;
  key: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'boolean' | 'media';
  required: boolean;
  options?: string[];
  validation?: { maxLength?: number; pattern?: string };
}

export interface ServicePageDto {
  id: string;
  name: string;
  pricingModel: 'fixed' | 'package' | 'hourly' | 'quote' | 'custom';
  priceDisplay: { type: 'exact' | 'starting' | 'range' | 'quote' | 'hourly'; amountMinorUnits?: number; currencyCode?: string };
  packages: ServicePackageDto[];
  fields: ServiceFieldDto[];
  faqs: Array<{ id: string; question: string; answer: string; source: 'official' | 'provider'; providerId?: string }>;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | field definition itself is malformed (e.g. `select` type with no `options`) |
| `403` | `FORBIDDEN` | provider attempts to edit another provider's FAQ, or edit official FAQs |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `ServiceField` | new | `id uuid pk`, `service_id uuid fk->Service`, `key text`, `label text`, `type text`, `required boolean`, `options jsonb nullable`, `validation jsonb nullable`, `sort_order integer` |
| `ServiceRequirement` | new | `id uuid pk`, `service_id uuid fk->Service`, `kind text` (media/duration/buffer/verification), `detail jsonb` |
| `ServiceFAQ` | new | `id uuid pk`, `service_id uuid fk->Service`, `provider_id uuid fk->ProviderProfile nullable` (null = official), `question text`, `answer text`, `source text` (official/provider/ai_suggested), `status text` (published/pending_review) |
| `ServicePackage` | new | `id uuid pk`, `service_id uuid fk->Service`, `provider_id uuid fk->ProviderProfile nullable`, `name text`, `description text`, `amount_minor_units integer`, `currency_code text`, `included_items jsonb` |

### Migration

- **Name:** `AddServicePageEntities`
- **Reversible:** yes
- **Backfill required:** minor — seed representative fields for the seeded services from spec
  010
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No personal data beyond `provider_id` attribution on packages/FAQs, already covered by profile
deletion rules (spec 008).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | service page skeleton (hero, price block, FAQ list all skeletoned independently) |
| **Empty** | a service with no packages/FAQs yet shows "Ask Apuriva" and request-service CTA instead of empty sections |
| **Error** | page-data fetch failure shows retry, preserves any in-progress request draft |
| **Success** | fully rendered page; "Book / Request Service" CTA reflects pricing model correctly |

Media-requirement guidance ("why this helps") is shown as inline help text, not a blocking
modal. FAQ source (official vs. provider) shown via icon+label, not color alone (master spec
§3.5).

**Route(s):** `apps/web/app/explore/[category]`, `apps/web/app/explore/[category]/[service]`
**Shared components used/added:** `packages/ui` `PriceDisplay` (new, pricing-model-aware),
`FAQList`, `PackageCard`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | pricing-model-to-display mapping, field-validation rule evaluation | `apps/api/services/**/*.test.ts` |
| **Integration** | field CRUD, FAQ approval flow, provider-vs-admin FAQ ownership | `apps/api/services/*.integration.test.ts` |
| **Component** | service page renders each pricing model correctly | `apps/web` (Testing Library) |
| **E2E** | customer views service page, sees correct pricing display and FAQs | `apps/web-e2e/service-page.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/web/PriceDisplay.test.tsx::renders each pricing model` |
| AC-3 | `apps/api/services/fields.integration.test.ts::rejects missing required field` |
| AC-5 | `apps/api/services/faq.integration.test.ts::ai suggestion hidden until approved` |
| AC-6 | `apps/web/FAQList.test.tsx::distinguishes official vs provider` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Provider-specific pricing/package management UI (that's the
provider-side authoring experience, part of provider onboarding, referenced but not detailed
here — this spec covers the customer-facing read path and the shared field-definition contract).

---

## 7. Out of scope

- Request-form rendering/submission logic itself (spec 015) — this spec only defines the field
  *schema* both the form and AI read from.
- Search/filter logic on category pages (spec 013).
- Recommended-providers ranking logic (spec 016).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | How AI-suggested FAQs are generated/queued — depends on spec 034's AI architecture existing first; this spec only defines the storage/approval state machine | — | Open, sequencing dependency noted |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema + seed field data ships together.
- **Rollback:** revert deploy.
- **Observability:** FAQ approval queue depth, page load performance (ties to spec 044).
