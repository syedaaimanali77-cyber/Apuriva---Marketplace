# Spec: Reviews & Ratings

**File:** `docs/specs/2026-08-28-029-reviews-ratings.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §52, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No review system exists. Master spec §52 requires reviews to only be generated from
eligible completed bookings (verified reviews), with rating, text, optional media, provider
response, and reporting; moderation must flag spam/manipulation/profanity via AI signals with
admin resolving disputed cases, and must never automatically suppress legitimate criticism.

**Who is affected:** Customers rating their experience; providers whose reputation depends on
review integrity; matching (016), which uses rating as a ranking factor.

**Why it matters now:** Depends on completed bookings existing (spec 028); feeds provider
ranking (016) and trust signals across the platform.

**Success looks like:** Only a customer with a genuinely completed, eligible booking can review
that specific provider/service; providers can respond; suspicious patterns are flagged for
admin review without auto-deleting legitimate negative reviews.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking that has not reached an eligible completed state **When** a review is attempted **Then** it is rejected — reviews can only be created against verified, eligible completed bookings |
| AC-2 | **Given** an eligible completed booking **When** the customer submits a rating + text (+ optional media) **Then** the review is published, linked to that specific booking |
| AC-3 | **Given** a published review **When** the provider responds **Then** the response is attached and visible alongside the review |
| AC-4 | **Given** a review flagged by AI as a suspicious pattern (spam/manipulation/profanity) **When** flagged **Then** it enters an admin queue for resolution, and is not automatically deleted or hidden before human review |
| AC-5 | **Given** a legitimate negative review **When** it doesn't match manipulation/spam patterns **Then** it remains visible — the system never auto-suppresses criticism solely for being negative |
| AC-6 | **Given** a user reporting a review **When** submitted **Then** it enters the same admin moderation queue with the reporter's stated reason |
| AC-7 | **Given** a duplicate review attempt on the same booking **When** attempted **Then** it is rejected — one review per eligible booking |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings/{id}/reviews` | session (customer, owner) | `201` `ApiResponse<ReviewDto>` | rejected if booking not eligible |
| `GET` | `/api/v1/providers/{id}/reviews` | none | `200` `PagedResponse<ReviewDto>` | published, non-suppressed only |
| `POST` | `/api/v1/reviews/{id}/response` | session (provider, owner of reviewed provider) | `201` `ApiResponse<ReviewResponseDto>` | |
| `POST` | `/api/v1/reviews/{id}/report` | session | `201` `ApiResponse<ReviewReportDto>` | |
| `GET` | `/api/v1/admin/reviews/moderation-queue` | admin (Trust & Safety / Content) | `200` `PagedResponse<ReviewDto>` | AI-flagged + user-reported |
| `POST` | `/api/v1/admin/reviews/{id}/resolve` | admin | `200` | keep/remove decision, reason required |

### Request and response types

```typescript
// packages/types/src/reviews.ts
export interface ReviewDto {
  id: string;
  bookingId: string;
  providerId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  text: string;
  mediaFileAssetIds: string[];
  status: 'published' | 'flagged_pending_review' | 'removed';
  providerResponse?: { text: string; createdAt: string };
  createdAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `BOOKING_NOT_ELIGIBLE_FOR_REVIEW` | booking not in a reviewable state |
| `409` | `REVIEW_ALREADY_EXISTS` | duplicate review on the same booking |
| `403` | `FORBIDDEN` | non-owner attempts to respond as the provider |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Review` | new | `id uuid pk`, `booking_id uuid fk->Booking unique`, `customer_id uuid fk->CustomerProfile`, `provider_id uuid fk->ProviderProfile`, `rating integer`, `text text`, `status text`, `ai_flag_reason text nullable`, `created_at` |
| `ReviewResponse` | new | `id uuid pk`, `review_id uuid fk->Review unique`, `text text`, `created_at` |
| `ReviewReport` | new | `id uuid pk`, `review_id uuid fk->Review`, `reported_by_user_id uuid fk->User`, `reason text`, `status text`, `created_at` |

`booking_id unique` on `Review` enforces one-review-per-booking at the database level (AC-7).

### Migration

- **Name:** `AddReviewTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Reviews are semi-public content tied to a real transaction; retained per platform policy,
included in customer data export; a removed review's removal reason is retained for audit even
if the review text itself is hidden from public view.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | review list skeleton on provider profile |
| **Empty** | provider with no reviews yet: neutral "No reviews yet" state, not implying poor quality |
| **Error** | submission failure (e.g. not yet eligible) explains exactly when the customer will be able to review |
| **Success** | published review appears on the provider profile; provider notified to respond |

Star rating input fully keyboard-operable (not mouse/touch-only); flagged-pending-review status
never shown publicly as "removed" before actual admin resolution.

**Route(s):** `apps/web/app/bookings/[id]/review`, review section on
`apps/web/app/providers/[id]`
**Shared components used/added:** `packages/ui` `RatingInput`, `ReviewCard`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | eligibility check, AI-flag-signal evaluation (spam/manipulation/profanity heuristics) | `apps/api/reviews/**/*.test.ts` |
| **Integration** | full submit→publish→respond→report→moderate flow; duplicate-review rejection | `apps/api/reviews/*.integration.test.ts` |
| **E2E** | customer reviews a completed booking, provider responds, another user reports it | `apps/web-e2e/reviews.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/reviews/eligibility.integration.test.ts::rejects non-eligible booking` |
| AC-4 | `apps/api/reviews/moderation.integration.test.ts::flags without auto-deleting` |
| AC-5 | `apps/api/reviews/moderation.integration.test.ts::negative-but-legitimate stays visible` |
| AC-7 | `apps/api/reviews/create.integration.test.ts::rejects duplicate` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The AI spam/manipulation-detection model's precision/recall
tuning — functional correctness of the flag→queue→resolve pipeline is tested, not the model's
classification quality (a product-iteration concern).

---

## 7. Out of scope

- Provider-ranking use of review data (spec 016 — this spec only produces the rating signal).
- Formal disputes arising from a review disagreement escalate to spec 031, not handled here.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact eligibility window (how soon after completion can a review be submitted, and until when) | Product | Open |
| 2 | AI flagging approach (rule-based heuristics vs. a model call through spec 033's AI abstraction) | — | Open — recommend starting rule-based, upgrading to AI-assisted once spec 033 exists |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy.
- **Observability:** review-submission rate, flag rate, and moderation-queue resolution time
  monitored (spec 040).
