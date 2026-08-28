# Spec: Provider Availability & Service Areas

**File:** `docs/specs/2026-08-28-019-provider-availability-service-areas.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §40–§42, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No availability or service-area model exists. Master spec §40 requires weekly
recurring schedules with date-specific overrides, buffers, and double-booking prevention; §41
requires configurable service areas (radius, specific cities, remote/online); §42 requires a
simplified customer-facing availability state (Available/Busy/Unavailable) while keeping the
provider discoverable even when unavailable.

**Who is affected:** Providers managing their schedule and coverage area; matching (spec 016),
which uses this as a hard eligibility rule; booking (spec 020), which must revalidate against
this at confirmation time.

**Why it matters now:** Matching (016) and booking (020) both depend on real availability/
service-area data rather than assuming providers are always available everywhere.

**Success looks like:** A provider sets a recurring weekly schedule with per-date overrides and
a service area (radius or city list, possibly per-service); the system prevents double-booking
server-side; customers see a simplified availability state without provider-schedule internals
exposed.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a provider's weekly recurring schedule (e.g. Mon–Fri 9:00–18:00) **When** a date-specific override marks a day unavailable **Then** the override takes precedence over the recurring pattern for that date |
| AC-2 | **Given** an existing confirmed booking occupying a time slot **When** any other booking attempt targets an overlapping slot for the same provider **Then** it is rejected server-side — never relying on the frontend to prevent the overlap |
| AC-3 | **Given** a provider's service area configured as "Lahore + 20km" **When** a request originates outside that radius **Then** the provider is excluded from eligibility (feeds spec 016 AC-1) |
| AC-4 | **Given** a provider's service configured as "remote/online" **When** matching runs **Then** location/radius rules are bypassed for that service appropriately |
| AC-5 | **Given** a provider currently unavailable **When** a customer views their profile **Then** the provider remains discoverable, but booking/offer actions are disabled with a clear reason shown |
| AC-6 | **Given** a customer wanting to know when an unavailable provider is free again **When** they save/follow the provider **Then** they can optionally request an availability notification |
| AC-7 | **Given** buffer times configured for a service **When** a booking is scheduled **Then** the buffer is respected in adjacent-slot availability calculations |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/providers/{id}/availability` | none | `200` `ApiResponse<AvailabilitySummaryDto>` | simplified state only for non-owner callers |
| `PUT` | `/api/v1/providers/me/availability/schedule` | session (provider) | `200` | recurring weekly schedule |
| `POST` | `/api/v1/providers/me/availability/overrides` | session (provider) | `201` | date-specific override |
| `GET` | `/api/v1/providers/me/availability/slots` | session (provider) | `200` `ApiResponse<SlotDto[]>` | full detail, owner-only |
| `PUT` | `/api/v1/providers/me/service-areas` | session (provider) | `200` | per-service or global area config |
| `POST` | `/api/v1/providers/{id}/availability-notify` | session (customer) | `201` | opt-in notification request |

### Request and response types

```typescript
// packages/types/src/availability.ts
export interface AvailabilitySummaryDto {
  state: 'available' | 'busy' | 'unavailable';
}

export interface WeeklyScheduleRequest {
  entries: Array<{ dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; startTime: string; endTime: string }>;
  timezone: string;
}

export interface ServiceAreaRequest {
  serviceId?: string; // omit for a global default
  mode: 'radius' | 'cities' | 'remote';
  radiusKm?: number;
  centerAddressId?: string;
  cities?: string[];
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `409` | `SLOT_OVERLAP` | schedule/override change would conflict with an existing confirmed booking |
| `422` | `INVALID_SCHEDULE_RANGE` | end time before start time, overlapping entries, etc. |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `ProviderAvailability` | new | `id uuid pk`, `provider_id uuid fk->ProviderProfile`, `day_of_week integer`, `start_time time`, `end_time time`, `timezone text` |
| `ProviderAvailabilityOverride` | new | `id uuid pk`, `provider_id uuid fk->ProviderProfile`, `date date`, `is_available boolean`, `start_time time nullable`, `end_time time nullable` |
| `ProviderServiceArea` | new | `id uuid pk`, `provider_id uuid fk->ProviderProfile`, `service_id uuid fk->Service nullable`, `mode text`, `radius_km numeric nullable`, `center_location_id uuid fk->Location nullable`, `cities jsonb nullable` |

Double-booking prevention is enforced via a database-level exclusion constraint (or equivalent
transactional check) on `(provider_id, time_range)` across confirmed bookings, not solely
application-layer logic.

### Migration

- **Name:** `AddAvailabilityServiceAreaTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No personal customer data; provider schedule data is business data tied to `ProviderProfile`,
covered by spec 008's export/deletion for provider accounts.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | calendar/schedule editor skeleton |
| **Empty** | new provider with no schedule set sees a setup prompt before going "Active" |
| **Error** | schedule save conflicting with an existing booking shows exactly which booking blocks it |
| **Success** | schedule/override saved, reflected immediately in matching/booking availability checks |

Customer-facing availability state (AC-5) always paired with explanatory text, never a bare
color dot (master spec §3.5).

**Route(s):** `apps/web/app/provider/schedule`
**Shared components used/added:** `packages/ui` `Calendar`, `WeeklyScheduleEditor` (new)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | schedule/override resolution precedence, buffer-aware slot calculation | `apps/api/availability/**/*.test.ts` |
| **Integration** | double-booking prevention under concurrent booking attempts; service-area eligibility check | `apps/api/availability/*.integration.test.ts` |
| **Component** | schedule editor states, override precedence display | `apps/web` (Testing Library) |
| **E2E** | provider sets schedule + override, customer sees correct simplified availability state | `apps/web-e2e/availability.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/availability/resolve.test.ts::override takes precedence` |
| AC-2 | `apps/api/availability/double-booking.integration.test.ts::rejects overlapping booking` |
| AC-3 | `apps/api/availability/service-area.integration.test.ts::excludes outside radius` |
| AC-5 | `apps/web/AvailabilityBadge.test.tsx::shows reason when disabled` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Travel-time-based dynamic availability adjustments — relies on
spec 012's location layer's optional travel-estimation capability, not guaranteed in MVP.

---

## 7. Out of scope

- Booking creation/confirmation itself (spec 020) — this spec only provides the availability
  data booking revalidates against.
- Matching's use of availability as a ranking *factor* (weight) vs. hard eligibility — the hard
  eligibility check is this spec's concern; the ranking weight is spec 016's.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact buffer-time defaults per service type | Product | Open |
| 2 | Whether double-booking prevention uses a DB exclusion constraint (Postgres `EXCLUDE USING gist`) or application-level locking | — | Open — recommend a DB-level constraint for defense-in-depth per master spec §39 |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy.
- **Observability:** double-booking-rejection rate and schedule-save error rate monitored
  (master spec §117).
