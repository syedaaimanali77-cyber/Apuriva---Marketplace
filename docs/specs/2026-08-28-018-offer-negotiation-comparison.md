# Spec: Offer Negotiation & Comparison

**File:** `docs/specs/2026-08-28-018-offer-negotiation-comparison.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §33–§36, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 017 provides the offer entity and timer but not negotiation or comparison.
Master spec §33 allows limited pre-booking chat tied to a request; §34–§35 require comparable
offer display (price, availability, rating, distance, badges, "why this provider") and
up-to-3-way provider comparison; §36 requires every price change to be recorded with final price
confirmed by both sides.

**Who is affected:** Customers deciding between multiple offers; providers clarifying request
details before committing a price.

**Why it matters now:** It's what makes the offer system (017) actually usable for informed
decisions rather than a bare accept/decline choice.

**Success looks like:** A customer can ask a clarifying question tied to a request before
selecting a provider, compare up to 3 offers side by side with a clear "why this provider"
explanation, and any revised offer is fully price-change-audited with both sides' confirmation
required before it's final.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** an open request **When** a customer sends a request-specific question to a provider **Then** the message is tied to that request, subject to anti-spam limits, and does not leak the customer's phone/email to the provider (master spec §54) |
| AC-2 | **Given** 2 or more open offers on a request **When** the customer views comparison **Then** up to 3 offers are shown side by side with price, availability/arrival, rating, distance, badges, what's included, provider message, and a "why this provider" explanation |
| AC-3 | **Given** an offer the customer wants changed **When** they request a change **Then** the provider can respond with Accept (of the original) or a revised offer — never a silent price change |
| AC-4 | **Given** any price change on an offer **When** it occurs **Then** an `OfferRevision` record captures the old and new price, actor, and timestamp |
| AC-5 | **Given** a revised offer **When** the customer accepts **Then** the accepted price is the exact price of the specific revision accepted, confirmed by both parties, never an ambiguous "latest" price resolved after the fact |
| AC-6 | **Given** a service/category where comparison has little value (e.g. single-offer-only pricing models) **When** viewed **Then** comparison UI is not shown |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/requests/{id}/messages` | session (customer or matched provider) | `201` `ApiResponse<OfferMessageDto>` | request-scoped, rate-limited |
| `GET` | `/api/v1/requests/{id}/messages` | session (participant) | `200` `ApiResponse<OfferMessageDto[]>` | |
| `GET` | `/api/v1/requests/{id}/offers/compare` | session (owner customer) | `200` `ApiResponse<OfferComparisonDto>` | max 3 offers |
| `POST` | `/api/v1/offers/{id}/request-change` | session (owner customer) | `200` | notifies provider, does not alter price itself |
| `POST` | `/api/v1/offers/{id}/revise` | session (provider, owner) | `200` `ApiResponse<OfferDto>` | creates new `OfferRevision`, resets 2-minute timer per spec 017 |

### Request and response types

```typescript
// packages/types/src/negotiation.ts
export interface OfferComparisonDto {
  offers: Array<{
    offerId: string;
    providerId: string;
    priceAmountMinorUnits: number;
    rating: number;
    distance: string;
    badges: string[];
    isTopMatch: boolean;
    whyThisProvider: string;
  }>;
}

export interface OfferMessageDto {
  id: string;
  requestId: string;
  senderType: 'customer' | 'provider';
  body: string;
  createdAt: string;
}
```

Backend strips any phone-number/email pattern from `body` before delivery per master spec §54,
flagging the sender if repeated attempts occur (feeds spec 038 fraud/abuse signals).

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `429` | `RATE_LIMITED` | anti-spam message limit exceeded |
| `403` | `FORBIDDEN` | non-participant attempts to message/view |
| `422` | `COMPARISON_LIMIT_EXCEEDED` | more than 3 offers requested for comparison |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

Reuses `OfferMessage` and `OfferRevision` (stubbed in spec 017) — this spec adds the
comparison-query logic and the "why this provider" explanation generation, plus:

| Entity | Change | Fields |
|---|---|---|
| `Request` | extend (spec 015) | `top_match_offer_id uuid nullable` (computed, not customer-editable) |

### Migration

- **Name:** `AddNegotiationSupportFields`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Pre-booking chat messages are request-scoped and follow spec 025's retention policy; contact-
info stripping is a privacy-critical rule tested explicitly (§6).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | comparison table skeleton |
| **Empty** | fewer than 2 offers: comparison UI hidden, single-offer view shown instead (AC-6) |
| **Error** | message-send failure (e.g. rate limited) shows remaining cooldown, preserves drafted text |
| **Success** | revised offer replaces prior in the comparison view with its own fresh countdown (per spec 017) |

State conveyed via icon+text+color (master spec §3.5), never color alone, for "Top Match" and
badge indicators. Fully responsive: comparison collapses to a stacked/swipeable layout on
mobile.

**Route(s):** `apps/web/app/requests/[id]/offers/compare`
**Shared components used/added:** `packages/ui` `ComparisonTable`, `Chat` (request-scoped,
reused by spec 025)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | contact-info-stripping regex/heuristics, "why this provider" explanation generation | `apps/api/negotiation/**/*.test.ts` |
| **Integration** | full negotiate→revise→accept flow with revision audit trail; anti-spam rate limiting | `apps/api/negotiation/*.integration.test.ts` |
| **Component** | comparison table renders ≤3 offers correctly, hidden when not applicable | `apps/web` (Testing Library) |
| **E2E** | customer compares 3 offers, requests a change, provider revises, customer accepts the revision | `apps/web-e2e/offer-negotiation.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/negotiation/messages.integration.test.ts::strips contact info` |
| AC-2 | `apps/web/ComparisonTable.test.tsx::shows up to 3 offers with required fields` |
| AC-4 | `apps/api/negotiation/revise.integration.test.ts::records offer revision audit trail` |
| AC-5 | `apps/api/negotiation/accept-revision.integration.test.ts::accepts exact revision price` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Full post-booking conversation (spec 025) — only the
request-scoped, pre-selection chat is this spec's concern.

---

## 7. Out of scope

- Booking creation after acceptance (spec 020).
- General messaging/conversation retention policy (spec 025).
- Off-platform contact-sharing detection beyond basic pattern stripping (deeper fraud signals
  are spec 038's concern; this spec only prevents the obvious leak).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact anti-spam message-rate threshold | Product | Open |
| 2 | "Why this provider" explanation generation — rule-based summary of ranking factors vs. AI-generated text (must not be AI-fabricated claims, per master spec §132.9) | — | Open — recommend rule-based templated text sourced from spec 016's real score breakdown, not free-form AI generation |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy.
- **Observability:** negotiation-to-acceptance conversion rate, message-abuse-flag rate
  monitored (spec 040).
