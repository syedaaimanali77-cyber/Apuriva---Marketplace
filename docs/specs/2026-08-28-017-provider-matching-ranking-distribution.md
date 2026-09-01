# Spec: Provider Matching, Ranking & Distribution

**File:** `docs/specs/2026-08-28-016-provider-matching-ranking-distribution.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §23–§25, §29–§30, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No matching engine exists. Master spec §23 requires a transparent rule-based engine:
hard eligibility rules first, then weighted ranking, with admin-configurable weights per
service. §24 requires fair exposure so new providers aren't permanently buried. §29–§30 require
distributing the request to a bounded, relevant provider pool (never blasting every provider)
and giving providers the correct action set (Accept/Send Offer/Decline) based on pricing model.

**Who is affected:** Every provider who wants fair access to requests; every customer who
depends on relevant, high-quality matches; admins who tune ranking weights.

**Why it matters now:** It's the second Milestone-4 spec, directly consuming submitted requests
from spec 015 and feeding offers (spec 017).

**Success looks like:** A submitted request is filtered through hard eligibility rules,
ranked by a transparent weighted formula, distributed to a configurably-sized relevant pool
(not everyone), and each notified provider sees the correct available action for that request's
pricing model.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a submitted request **When** matching runs **Then** providers failing any hard eligibility rule (service match, service area, availability, verification status, capacity) are excluded before ranking ever runs |
| AC-2 | **Given** eligible providers **When** ranked **Then** the ranking uses the documented weighted factors (service match, availability, location, rating, reliability, price fit, experience, verification, historical performance) with weights configurable per service by an admin |
| AC-3 | **Given** a newly-joined provider with no history **When** eligible for a request **Then** they receive limited exploration exposure rather than being permanently ranked last by lack-of-history alone |
| AC-4 | **Given** the ranked eligible pool **When** distributed **Then** only a configurable-sized subset of top-ranked providers is notified, never the entire eligible set |
| AC-5 | **Given** a fixed/instant-pricing-model service **When** a provider views the request **Then** their available action is "Accept"; **given** a quote-based service **Then** their action is "Send Offer"; **given** unsuitability **Then** "Decline" is always available |
| AC-6 | **Given** an admin **When** viewing ranking behavior for a request **Then** they can see which providers were excluded and why (explainability, master spec §2.3) |
| AC-7 | **Given** the ranking weights **When** the AI suggests an improvement **Then** the suggestion is recorded for admin review and never silently applied (master spec §23, §132.16) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/requests/{id}/matches` | admin (Operations) | `200` `ApiResponse<MatchResultDto>` | explainable eligibility/ranking breakdown |
| `GET` | `/api/v1/providers/me/requests` | session (provider, ownership-checked) | `200` `PagedResponse<IncomingRequestDto>` | pool this provider was distributed into |
| `POST` | `/api/v1/providers/me/requests/{id}/accept` | session (provider) | `200` | fixed/instant pricing model only |
| `POST` | `/api/v1/providers/me/requests/{id}/decline` | session (provider) | `200` | |
| `PATCH` | `/api/v1/admin/services/{id}/matching-weights` | admin (Operations, Super Admin) | `200` | risk-tier: medium |

### Request and response types

```typescript
// packages/types/src/matching.ts
export interface MatchResultDto {
  requestId: string;
  eligiblePool: Array<{ providerId: string; rank: number; scoreBreakdown: Record<string, number> }>;
  excluded: Array<{ providerId: string; reason: string }>;
  notifiedProviderIds: string[];
}

export interface IncomingRequestDto {
  requestId: string;
  serviceId: string;
  availableAction: 'accept' | 'send_offer' | 'decline_only';
  distance: string;
  summary: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL` | provider attempts "Accept" on a quote-based service |
| `403` | `FORBIDDEN` | provider attempts to act on a request they weren't distributed into |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `RequestProviderMatch` | new | `id uuid pk`, `request_id uuid fk->Request`, `provider_id uuid fk->ProviderProfile`, `rank integer`, `score_breakdown jsonb`, `eligible boolean`, `exclusion_reason text nullable`, `notified boolean`, `provider_response text nullable` (accepted/declined/offer_sent/none), `created_at` |
| `Service` | extend (spec 010) | `matching_weights jsonb nullable` (admin-configurable per-service override of default weights) |
| `MatchingSuggestion` (AI suggestions, master spec §23) | new | `id uuid pk`, `service_id uuid fk->Service nullable`, `suggested_weights jsonb`, `rationale text`, `status text` (pending_review/applied/rejected), `created_at` |

### Migration

- **Name:** `AddMatchingTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

`RequestProviderMatch` links two parties' activity — retained per platform data policy;
excluded/declined records feed provider fairness analytics (spec 040) in aggregate, not
individually exposed to other providers.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | provider's incoming-requests list skeleton |
| **Empty** | "No new requests right now" with guidance (broaden service areas, check availability) rather than a bare empty screen |
| **Error** | accept/decline failure (e.g. request already taken) shows a specific message, not a generic error |
| **Success** | accepted/declined state reflected immediately; admin matching-explainability view renders exclusion reasons per provider |

**Route(s):** `apps/web/app/provider/requests`, `apps/web/app/admin/marketplace/matching`
**Shared components used/added:** `packages/ui` `Table`, `ScoreBreakdown` (new, admin-only)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | eligibility-rule evaluation, weighted-ranking formula, exploration-exposure boost for new providers | `apps/api/matching/**/*.test.ts` |
| **Integration** | end-to-end: submitted request → eligible pool computed → notified subset → provider action reflects pricing model | `apps/api/matching/*.integration.test.ts` |
| **Component** | provider incoming-requests list, action buttons per pricing model | `apps/web` (Testing Library) |
| **E2E** | provider receives a distributed request and accepts/declines correctly per pricing model | `apps/web-e2e/matching.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/matching/eligibility.test.ts::excludes ineligible providers before ranking` |
| AC-2 | `apps/api/matching/ranking.test.ts::weighted formula configurable per service` |
| AC-3 | `apps/api/matching/fairness.test.ts::new provider gets exploration exposure` |
| AC-4 | `apps/api/matching/distribution.integration.test.ts::notifies bounded subset only` |
| AC-7 | `apps/api/matching/ai-suggestions.integration.test.ts::never auto-applies` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Long-run ranking-quality/relevance tuning — functional
correctness of the pipeline is tested, not subjective match quality (a product-iteration
concern, not an acceptance criterion here).

---

## 7. Out of scope

- Offer creation itself once a provider chooses "Send Offer" (spec 017).
- Sponsored placements (explicitly Phase 2, master spec §25, §122).
- Advanced ML ranking (explicitly Phase 2, master spec §122) — this spec is the rule-based engine
  only.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Default pool size (how many providers get notified per request) | Product | Open — must be configurable, ship with a sane default |
| 2 | Exact default weight values per ranking factor | Product | Open — must be confirmed before launch, admin-adjustable per spec §23 |

---

## 9. Rollout

- **Feature flag:** `matching-fairness-exposure` (default on) — allows disabling new-provider
  exposure boost independently if it degrades match quality.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; `matching_weights` config remains valid data, not destroyed.
- **Observability:** match-to-offer conversion rate, provider exposure distribution (fairness
  metric), and matching latency monitored (spec 040).
