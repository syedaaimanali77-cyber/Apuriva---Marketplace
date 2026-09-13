# Spec: Provider Availability & Service Areas

**File:** `docs/specs/2026-08-28-016-provider-availability-service-areas.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §39–§42, §124, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (the baseline `provider_availabilities` / `provider_availability_overrides`
/ `provider_service_areas` tables), spec 004 (API envelope, error codes, rate limiting, OpenAPI
registry), spec 006 (`provider_profiles`), spec 008 (export/deletion), spec 010 (`services`),
spec 012 (`lib/location/*` geo and service-area primitives).
**Feeds:** spec 017 (matching eligibility — this spec's AC-3 feeds spec 017 AC-1) and spec 020
(booking revalidates against this at confirmation). The established order is unchanged:
**015 → 016 → 017 → 018 → 019 → 020**, exactly as `docs/specs/INDEX.md` and `docs/specs/README.md`
record it.

> **Numbering note.** The four Milestone-4 specs were drafted one number lower than they now ship
> (draft 016 = matching, 017 = offer system, 018 = negotiation, 019 = availability). The
> repository's authoritative numbering — `docs/specs/INDEX.md`, `docs/specs/README.md`, and
> approved spec 015 §7 — is **016 = this spec, 017 = matching, 018 = offer system & timer,
> 019 = offer negotiation & comparison**. Every cross-reference below uses that numbering. No
> other spec is renumbered.

---

## 1. Problem statement

**Today:** No availability or service-area behaviour exists. The three tables
`provider_availabilities`, `provider_availability_overrides` and `provider_service_areas`
**already exist** in `lib/db/schema.ts` as spec 003's deliberately minimal baseline skeletons —
`id`, `created_at`, `updated_at`, `version` and a single `provider_profile_id` FK, with **no**
day, time, date, radius or city columns at all. Spec 012 shipped the geo primitives
(`lib/location/geo.ts`, `lib/location/service-area.ts`) and left a deliberately inert
`GET /api/v1/providers/{id}/service-area-check` that always answers `{ inServiceArea: true }`
because no provider can yet declare an area; that route's own file header names this spec as the
one that adds the columns. `app/provider/schedule/page.tsx` is a spec-014 `PlaceholderPage` that
names this spec too.

Master spec §40 requires weekly recurring schedules with date-specific overrides, blocked periods,
service-specific durations, buffer times, timezone awareness and double-booking prevention; §41
requires configurable service areas (radius, specific cities/areas, service-specific coverage,
remote/online); §42 requires a simplified customer-facing availability state
(Available/Busy/Unavailable) while keeping the provider discoverable even when unavailable; §39
requires booking confirmation to revalidate availability and prevent race-condition double booking
server-side.

**Who is affected:** Providers managing their schedule and coverage area; matching (**spec 017**),
which uses this as a hard eligibility rule; booking (**spec 020**), which must revalidate against
this at confirmation time.

**Why it matters now:** Matching (017) and booking (020) both depend on real availability/
service-area data rather than assuming providers are always available everywhere.

**Success looks like:** A provider sets a recurring weekly schedule with per-date overrides and a
service area (radius or city list, globally or per service); the system prevents double-booking
server-side; customers see a simplified availability state without provider-schedule internals
exposed.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a provider's weekly recurring schedule (e.g. Mon–Fri 9:00–18:00) **When** a date-specific override exists for a date **Then** the override wholly replaces the recurring pattern for that date — `is_available = false` makes the whole local day unavailable regardless of the weekly rows, and `is_available = true` with `start_minute`/`end_minute` makes exactly that window the day's availability. Resolution never merges an override with the weekly pattern (§3 "Schedule resolution", rule R3) |
| AC-2 | **Given** an existing confirmed booking occupying a time slot **When** any other booking attempt targets an overlapping slot for the same provider **Then** it is rejected server-side with `409 SLOT_OVERLAP` by this spec's `reserveProviderSlot()` primitive (§3), which takes the provider row lock, evaluates overlap, and refuses the reservation **inside the caller's writing transaction**, so two simultaneous attempts can never both succeed. Enforcement never relies on the frontend, and never on a read performed outside the writing transaction. This spec ships and owns that primitive and its serialization guarantee; **spec 020 is its only caller and supplies the booked intervals** from the `bookings` columns spec 020 owns (§3 "Interface with spec 020") |
| AC-3 | **Given** a provider's service area configured as "Lahore + 20 km" (`mode = 'radius'`, `center_address_id` → an address whose `locations` row is the Lahore point, `radius_meters = 20000`) **When** a request whose `requests.address_id` resolves to a point farther than 20 km from that center is evaluated **Then** `isProviderEligibleForLocation()` returns `false` and the provider is excluded from eligibility (feeds **spec 017** AC-1), and `GET /api/v1/providers/{id}/service-area-check` answers `{ inServiceArea: false }` for that point |
| AC-4 | **Given** a provider's service configured as `mode = 'remote'` (a `provider_service_areas` row carrying that `service_id`) **When** eligibility is evaluated for that service **Then** radius/city rules are bypassed for that service and the provider is eligible for any request origin — while the provider's other services keep their own or the global area unchanged (§3 "Service-area resolution", rule S2) |
| AC-5 | **Given** a provider whose resolved state is `busy` or `unavailable` **When** a customer views their profile **Then** the provider remains discoverable (the profile renders and search/matching still lists them) but booking/offer actions are disabled, and `GET /api/v1/providers/{id}/availability` returns the state together with a non-null `reason` string rendered as explanatory text beside the state — never a bare colour dot (master spec §3.5) |
| AC-6 | **Given** a customer wanting to know when an unavailable provider is free again **When** they call `POST /api/v1/providers/{id}/availability-notify` **Then** a `provider_availability_notification_requests` row is created (`201`) for that customer/provider pair; a second call while one is still `pending` returns `200` with the same id rather than creating a duplicate row; and a request naming a provider already resolved `available` is rejected `422 AVAILABILITY_NOTIFY_NOT_APPLICABLE` |
| AC-7 | **Given** a buffer configured for a provider's service (`provider_services.buffer_before_minutes` / `buffer_after_minutes`) **When** slots are computed or a slot is reserved **Then** the booked interval is widened by those buffers on both sides for every overlap test, so a slot adjacent to an existing booking within the buffer is reported unavailable and is rejected `409 SLOT_OVERLAP` if attempted |

---

## 3. API contract

Routes live at `app/api/v1/providers/**/route.ts` (Next.js App Router — this repository is a
single Next.js app, **not** the `apps/web` + `apps/api` + `packages/ui` + `packages/types` layout
the template prose assumes). Every route is `withApiRoute` (`lib/api/handler.ts`) wrapping a call
into `lib/availability/*`; every mutation calls `requireSession` + `requireCsrf`
(`lib/auth/require-session.ts`) and `requireActiveMode(session, 'provider')`
(`lib/auth/require-mode.ts`), except the customer-facing notify route, which requires
`'customer'`. Ownership is resolved by looking up the `provider_profiles` row whose `user_id` is
the session user — the `me` routes never accept a provider id from the client, so they have no
IDOR surface.

**OpenAPI:** every route below must be added to `OPENAPI_ROUTES` in `lib/api/openapi-registry.ts`
in the same PR — `scripts/check-openapi-drift.ts` fails CI otherwise.

**Rate limiting:** a new `availability` domain is added to `RateLimitDomain` /
`RATE_LIMIT_DEFAULTS` (`lib/api/rate-limit.ts`) at `60 / 60_000`, the same way spec 014 added
`home` and spec 015 added `requests`. The public read is keyed by `hashRequestIp` for guests and
by `session.userId` otherwise, exactly as spec 012's `service-area-check` already does.

### Endpoints

| Method | Route | Auth | Success | Errors |
|---|---|---|---|---|
| `GET` | `/api/v1/providers/{id}/availability` | session **or** guest (`getOptionalSession`) | `200` `ApiResponse<AvailabilitySummaryDto>` | `404 NOT_FOUND` (no such provider), `429 RATE_LIMITED` |
| `GET` | `/api/v1/providers/me/availability/schedule` | session, provider mode | `200` `ApiResponse<WeeklyScheduleDto>` | `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND` (session user has no provider profile) |
| `PUT` | `/api/v1/providers/me/availability/schedule` | session, provider mode, CSRF | `200` `ApiResponse<WeeklyScheduleDto>` | `400 VALIDATION_ERROR`, `409 CONFLICT` (stale `expectedVersion`), `409 SLOT_OVERLAP`, `422 INVALID_SCHEDULE_RANGE` |
| `GET` | `/api/v1/providers/me/availability/overrides?from=&to=` | session, provider mode | `200` `ApiResponse<OverrideDto[]>` | `400 VALIDATION_ERROR` (bad or inverted date range) |
| `POST` | `/api/v1/providers/me/availability/overrides` | session, provider mode, CSRF | `201` `ApiResponse<OverrideDto>` | `400`, `409 CONFLICT` (a row already exists for that date — use `PUT`), `409 SLOT_OVERLAP`, `422 INVALID_SCHEDULE_RANGE` |
| `PUT` | `/api/v1/providers/me/availability/overrides/{date}` | session, provider mode, CSRF | `200` `ApiResponse<OverrideDto>` | `400`, `404 NOT_FOUND`, `409 SLOT_OVERLAP`, `422 INVALID_SCHEDULE_RANGE` |
| `DELETE` | `/api/v1/providers/me/availability/overrides/{date}` | session, provider mode, CSRF | `204` (no body) | `404 NOT_FOUND` |
| `GET` | `/api/v1/providers/me/availability/slots?serviceId=&from=&to=` | session, provider mode | `200` `ApiResponse<SlotDto[]>` | `400 VALIDATION_ERROR` (`to` before `from`, range wider than 62 days), `404 NOT_FOUND` (unknown `serviceId`) |
| `GET` | `/api/v1/providers/me/service-areas` | session, provider mode | `200` `ApiResponse<ServiceAreaDto[]>` | `401`, `403`, `404 NOT_FOUND` |
| `PUT` | `/api/v1/providers/me/service-areas` | session, provider mode, CSRF | `200` `ApiResponse<ServiceAreaDto[]>` | `400 VALIDATION_ERROR`, `422 INVALID_SERVICE_AREA`, `409 CONFLICT` |
| `POST` | `/api/v1/providers/{id}/availability-notify` | session, customer mode, CSRF | `201` (created) or `200` (existing pending returned) `ApiResponse<AvailabilityNotifyDto>` | `404 NOT_FOUND`, `422 AVAILABILITY_NOTIFY_NOT_APPLICABLE`, `429 RATE_LIMITED` |

`GET /api/v1/providers/{id}/service-area-check` (spec 012) is **not** re-declared here; this spec
replaces its inert body with a real call into `isProviderEligibleForLocation()`. Its path, auth,
response shape and rate-limit domain are unchanged, so it is not an API breaking change.

### Public vs owner-only information

`GET /api/v1/providers/{id}/availability` is the **only** availability endpoint a non-owner may
call, and it returns exactly `AvailabilitySummaryDto` below — a state, a human reason, and an
optional coarse `nextAvailableDate` (a local calendar date, never a time). It must never expose
weekly rows, override rows, slot boundaries, booking counts or ids, buffers, service areas, or the
provider's timezone. Everything else lives under `/providers/me/**` and is readable only by the
owning provider. Spec 012's privacy rule is preserved: no endpoint here returns a provider's exact
coordinates — `ServiceAreaDto` gives the **owner** the address id they chose plus a
`centerApproxAreaLabel` (`lib/location/privacy.ts`), and gives a non-owner nothing at all.

### Request and response types

```typescript
// lib/types/availability.ts  (this repository has no packages/types)

/** Minutes from local midnight, 0–1440. 1440 is only ever an end boundary ("to midnight"). */
export type MinuteOfDay = number;

/** The only availability shape a non-owner ever receives (master spec §42). */
export interface AvailabilitySummaryDto {
  state: 'available' | 'busy' | 'unavailable';
  /** Always present — AC-5 forbids a bare state with no explanation. */
  reason: string;
  /** Local calendar date (YYYY-MM-DD) in the provider's scheduling timezone, or null. */
  nextAvailableDate: string | null;
}

export interface WeeklyScheduleEntry {
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, matching JS Date#getDay()
  startMinute: MinuteOfDay;
  endMinute: MinuteOfDay;
}

export interface WeeklyScheduleDto {
  /** IANA identifier, e.g. "Asia/Karachi". */
  timezone: string;
  entries: WeeklyScheduleEntry[];
  version: number;
}

export interface WeeklyScheduleRequest {
  timezone: string;
  entries: WeeklyScheduleEntry[];
  /** Optimistic concurrency (spec 003 AC-6); omitted only on the first save. */
  expectedVersion?: number;
}

export interface OverrideDto {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  isAvailable: boolean;
  startMinute: MinuteOfDay | null;
  endMinute: MinuteOfDay | null;
}

export interface SlotDto {
  /** UTC instant of the slot start. */
  startAt: string;
  endAt: string;
  /** false when a booking (widened by buffers), an override, or the schedule blocks it. */
  available: boolean;
  blockedBy: 'booking' | 'override' | 'outside_schedule' | null;
}

export type ServiceAreaMode = 'radius' | 'cities' | 'remote';

export interface ServiceAreaDto {
  /** null = the provider's global default, applied to every service with no row of its own. */
  serviceId: string | null;
  mode: ServiceAreaMode;
  radiusKm: number | null;
  centerAddressId: string | null;
  centerApproxAreaLabel: string | null; // owner-only, never exact coordinates
  cities: string[] | null;
}

export interface ServiceAreaRequest {
  serviceId?: string | null;
  mode: ServiceAreaMode;
  radiusKm?: number;        // integer 1–500, required when mode = 'radius'
  centerAddressId?: string; // required when mode = 'radius'
  cities?: string[];        // 1–50 entries, required when mode = 'cities'
}

/** `PUT /providers/me/service-areas` replaces the whole set in one transaction. */
export interface ServiceAreasRequest {
  areas: ServiceAreaRequest[];
}

export interface AvailabilityNotifyDto {
  id: string;
  status: 'pending' | 'sent' | 'cancelled';
  createdAt: string;
}
```

### Schedule resolution (AC-1, AC-7)

These rules are the complete definition — nothing below is left to implementer judgement.

- **R1 — timezone.** All weekly entries and overrides are **local wall-clock** values in the
  provider's single `provider_profiles.scheduling_timezone` (IANA). One timezone per provider,
  never per row — the draft's per-row `timezone` column is dropped. It defaults to
  `'Asia/Karachi'` when the client omits it on first save. A weekly schedule is not an instant, so
  spec 003's `scheduledTimeColumns()` (timestamptz + IANA) convention does not apply to it;
  converting local minutes to a UTC instant for a given date goes through the provider's timezone
  and therefore follows that zone's DST rules by construction.
- **R2 — weekly entries.** Zero or more entries per `dayOfWeek`, with
  `0 <= startMinute < endMinute <= 1440`. Two entries on the same day must not overlap **or
  touch** (after sorting, `a.endMinute < b.startMinute`); touching entries must be submitted as one
  merged entry, which removes any "duplicate/adjacent entry" ambiguity at read time. A day with no
  entry is unavailable. An empty `entries` array is valid and means "never available" — the
  provider stays discoverable (AC-5).
- **R3 — override precedence.** For a given local date, an override row **wholly replaces** the
  weekly pattern for that date. `isAvailable = false` → the entire day is unavailable and
  `startMinute`/`endMinute` must be null. `isAvailable = true` → both are required and define the
  day's **only** window. Overrides are never merged, unioned, or intersected with weekly rows.
  This covers §40's "blocked periods": a blocked period is one or more unavailable-override dates.
- **R4 — one override per date.** `(provider_profile_id, date)` is unique. `POST` for a date that
  already has a row returns `409 CONFLICT`; `PUT .../overrides/{date}` updates it; `DELETE`
  removes it and restores the weekly pattern for that date.
- **R5 — no cross-midnight windows.** A window that would run past local midnight is rejected
  `422 INVALID_SCHEDULE_RANGE`. A provider working 22:00–02:00 expresses it as two entries —
  `{ day D, 1320, 1440 }` and `{ day D+1, 0, 120 }`. Keeping every window inside one local date is
  what makes R3's "the override replaces the date" rule unambiguous.
- **R6 — invalid ranges.** `endMinute <= startMinute`, either value outside `0–1440`, a
  non-integer, a `startMinute` of 1440, overlapping/touching entries, or an unknown IANA timezone
  → `422 INVALID_SCHEDULE_RANGE` naming the offending entry index. A malformed *shape* (missing
  field, wrong type, bad `YYYY-MM-DD`) → `400 VALIDATION_ERROR`, per spec 004's split between
  shape failures and domain-rule failures.
- **R7 — slot boundaries.** Slots are generated on a fixed **30-minute grid aligned to local
  midnight**. A service's `provider_services.duration_minutes` may span several grid steps; a
  candidate slot is offered only when the whole `[start, start + duration_minutes)` interval falls
  inside one resolved window for that date and overlaps no booked interval. All intervals are
  **half-open**, so a slot ending exactly when a window ends, or exactly when a booking starts, is
  available.
- **R8 — buffers.** `provider_services.buffer_before_minutes` / `buffer_after_minutes` (integers
  ≥ 0, default 0) widen an already-occupied interval — a `BusyInterval` supplied by the caller
  (§3 "Interface with spec 020") — from `[startAt, endAt)` to
  `[startAt − buffer_before, endAt + buffer_after)` for every overlap test. The buffers come from
  `provider_services` for that interval's `serviceId`; this spec never reads a booking column to
  obtain them. They never widen the schedule window itself, so a buffer can never make a provider
  available outside their declared hours.
- **R9 — customer-facing state (§42).** Resolved at request time from R1–R8 against the provider's
  global schedule. `unavailable` when the provider has no weekly entries at all, or today is
  overridden unavailable, or `provider_profiles.lifecycle_status` is not `active`; `busy` when the
  provider is inside a declared window right now but every remaining slot today is taken;
  `available` otherwise. `reason` is a fixed phrase per case (e.g. "Outside working hours", "Fully
  booked today", "Not accepting work right now") and never carries a schedule detail.

### Service-area resolution (AC-3, AC-4)

- **S1 — rows.** A `provider_service_areas` row with `service_id IS NULL` is the provider's global
  default; a row with a `service_id` is that service's own area. `(provider_profile_id, service_id)`
  is unique, with a separate partial unique index covering the `NULL` case so a provider has at
  most one global row.
- **S2 — lookup.** Eligibility for `(provider, service, point)` uses the service's own row when one
  exists, else the global row. **No row at all = unrestricted**, which preserves exactly the
  behaviour spec 012's `service-area-check` ships with today (a provider who has not configured an
  area is not excluded). `mode = 'remote'` on the chosen row bypasses every geographic test, which
  is master spec §41's "nationwide/online" case.
- **S3 — the "Lahore + 20 km" example, in the real model.** `mode = 'radius'`, `center_address_id`
  → an `addresses` row owned by the provider's user whose `location_id` → `locations` carries
  `latitude_micro_degrees` / `longitude_micro_degrees` for the Lahore point, and
  `radius_meters = 20000`. Evaluation converts both points through `fromMicroDegrees()`
  (`lib/location/geo.ts`) and calls
  `isWithinServiceArea({ point, city }, { kind: 'radius', center, radiusMeters })`
  (`lib/location/service-area.ts`). This spec maps rows into that existing primitive and never
  reimplements distance maths.
- **S4 — the candidate point.** For matching (spec 017) the candidate is the request's origin:
  `requests.address_id` → `addresses.location_id` → `locations` for coordinates, and
  `addresses.structured.city` (spec 012's `StructuredAddress`) for the `cities` comparison, which
  is case- and whitespace-insensitive exactly as `isWithinServiceArea` already implements. For
  `service-area-check` the candidate is the `lat`/`lng` query pair. A candidate with no
  coordinates is treated as **not** inside a radius area — never silently eligible.
- **S5 — validation (`422 INVALID_SERVICE_AREA`).** `mode = 'radius'` without both `radiusKm` and
  `centerAddressId`; `radiusKm` non-integer or outside `1–500`; `centerAddressId` not owned by the
  caller's user; `mode = 'cities'` with an empty list, more than 50 entries, or a blank entry;
  `mode = 'remote'` with any of `radiusKm`/`centerAddressId`/`cities` set; a `serviceId` the
  provider does not offer (no `provider_services` row); or two entries in one `areas` array naming
  the same `serviceId`. The `PUT` replaces the whole set inside one transaction, so a rejected
  entry leaves the previous configuration completely untouched.

### Double-booking prevention (AC-2) — resolved

**Primary mechanism: an application-level check inside the writing transaction, serialized by a
row lock on the provider.** The draft left this as an Open Question; it is decided here.

```
-- inside spec 020's booking-confirmation transaction
BEGIN;
  -- (1) spec 016: serialize every scheduling decision for this provider
  SELECT id FROM provider_profiles WHERE id = $providerProfileId FOR UPDATE;
  -- (2) spec 016: resolve the schedule (R1–R9) and test the candidate interval against
  --     the busy intervals the caller supplies, each widened by that service's buffers (R8)
  -- ... any overlap -> throw 409 SLOT_OVERLAP, caller rolls back
  -- (3) spec 020: INSERT INTO bookings (...)
COMMIT;
```

Steps (1) and (2) are this spec's `reserveProviderSlot()` in `lib/availability/reserve.ts`; step
(3) is spec 020's. Two concurrent attempts for the same provider cannot both pass: the second
blocks on the `FOR UPDATE` taken in step (1) until the first transaction commits, then observes
its row. The lock is taken **before** the overlap read, inside the same transaction as the write,
which is precisely what makes the check race-free.

Why this rather than a Postgres `EXCLUDE USING gist` constraint:

- An exclusion constraint over `(provider_profile_id WITH =, tstzrange WITH &&)` requires the
  `btree_gist` extension. **No migration in `drizzle/` has ever issued `CREATE EXTENSION`**, and
  the deployment target is not guaranteed to permit one. The constraint would also have to be
  partial on `bookings.status = 'confirmed'`, hard-coding a status vocabulary that is **spec
  020's** to define — `bookings.status` is bare `text` today and `bookings_status_transitions` is
  still empty.
- Row-level locking plus a transactional check is the repository's established concurrency idiom
  (`lib/db/concurrency.integration.test.ts`, spec 003 AC-6) and needs nothing new.
- It satisfies master spec §39 as written: revalidate and prevent the race at confirmation, on the
  server.

The exclusion constraint is recorded in §7 as **deferred hardening for spec 020**, to be added once
that spec fixes the booking status vocabulary — not as an open question, and not as something this
spec's correctness depends on.

### Interface with spec 020 (booking scheduling columns)

**This spec adds no column to `bookings`.** Spec 003 AC-4 states that every baseline table stays
"minimal/empty of feature columns **pending its owning spec**", and §4 that "feature-specific
columns are added by the owning spec". `bookings` is owned by **spec 020**, which is already
**Approved** and whose §4 explicitly declares `scheduled_at timestamptz` on `Booking`. A booking's
scheduled time is part of booking creation, not of provider availability, so spec 016 must not
claim it.

`reserveProviderSlot()` is therefore **booking-agnostic**: it never reads the `bookings` table and
contains no booking SQL. It is parameterized over a busy-interval port that the caller supplies,
so this spec depends on spec 020's *interface*, not on its columns:

```typescript
// lib/availability/reserve.ts — owned by this spec

/** A provider-occupied interval. Half-open [startAt, endAt), UTC (R7). */
export interface BusyInterval {
  startAt: Date;
  endAt: Date;
  /** Used to widen the interval by that service's buffers (R8). */
  serviceId: string;
  /** Opaque to this spec; echoed into the owner-only SLOT_OVERLAP message. */
  sourceId: string;
}

/** Supplied by the caller from whatever it considers "occupied" — spec 020 supplies
 *  confirmed bookings. This spec never queries `bookings` itself. */
export type BusyIntervalLoader = (
  tx: Tx,
  providerProfileId: string,
  range: { from: Date; to: Date },
) => Promise<BusyInterval[]>;

/**
 * Runs inside the CALLER's transaction. Takes the provider row lock, resolves the schedule
 * (R1–R9), applies buffers (R8), and throws `409 SLOT_OVERLAP` if the candidate interval
 * overlaps any loaded busy interval or falls outside a resolved window. Returns normally —
 * writing nothing — when the slot is free; the caller then performs its own INSERT inside the
 * same transaction, while still holding the lock.
 */
export async function reserveProviderSlot(
  tx: Tx,
  params: { providerProfileId: string; serviceId: string; startAt: Date; durationMinutes: number },
  loadBusyIntervals: BusyIntervalLoader,
): Promise<void>;
```

**What spec 020 must do (this spec's requirement on it, satisfied by spec 020's own AC-1/AC-2):**

1. Add the scheduling columns to `bookings` as part of its own §4 — at minimum `scheduled_at`
   (already declared there) and a duration or end instant. Spec 016 needs no particular column
   *name*; it only needs spec 020's loader to return `BusyInterval`s.
2. Pass a `BusyIntervalLoader` that selects that provider's **confirmed** bookings overlapping
   the candidate range, using spec 020's own booking status vocabulary — which is spec 020's to
   define, and which is exactly why this spec cannot write that query.
3. Call `reserveProviderSlot()` inside the same transaction as its booking `INSERT`, before the
   insert, and map a thrown `SLOT_OVERLAP` onto its own `422 SLOT_NO_LONGER_AVAILABLE` +
   alternatives response (spec 020 AC-2). The two codes coexist: `SLOT_OVERLAP` is this spec's
   primitive-level failure, `SLOT_NO_LONGER_AVAILABLE` is spec 020's customer-facing rendering of
   it.

This is the same direction of dependency spec 012 already has with this spec: spec 012 shipped
`isWithinServiceArea()` as a pure primitive and left the storage and the query to its consumer.

**Before spec 020 ships.** This spec's own schedule and override write paths also need busy
intervals, to refuse a change that would strand an already-confirmed booking. They obtain them
through the same port, resolved from a single-slot registry in
`lib/availability/busy-intervals.ts`:

```typescript
export function registerBusyIntervalLoader(loader: BusyIntervalLoader): void;
/** Defaults to a loader returning [] — no bookings can exist until spec 020 ships. */
export function getBusyIntervalLoader(): BusyIntervalLoader;
```

Spec 020 registers the real loader at startup; until then the default returns an empty list,
which is **correct rather than a stub**, because no code can create a booking with a scheduled
time until spec 020 adds those columns. This is exactly the precedent spec 012 set by shipping
`service-area-check` inert and naming the later spec that makes it real. Consequently
`reserveProviderSlot()` is fully implemented and fully tested here — its tests drive the port
directly with supplied intervals — and becomes live against real bookings the moment spec 020
registers its loader, with no change to this spec's code.

A **service's** duration and buffers are *not* affected by this boundary: they live on
`provider_services` (§4), which this spec legitimately owns as part of master spec §40's
"service-specific durations" and "buffer times".

### Error codes

Extends spec 004's `API_ERROR_CODES` table in the established SCREAMING_SNAKE_CASE + stability way.
Codes not in the shared baseline map are thrown as
`new ApiRouteError(code, message, { status })`, exactly as spec 005's codes already are.

| HTTP | `code` | When | Response detail |
|---|---|---|---|
| `409` | `SLOT_OVERLAP` | a reservation, or a schedule/override change, would conflict with an occupied interval returned by the registered `BusyIntervalLoader` — in practice an existing confirmed booking once spec 020 registers its loader | message names the conflicting local date and window; the interval's `sourceId` is included **only** for the owning provider, never for a customer |
| `422` | `INVALID_SCHEDULE_RANGE` | any R2/R5/R6 violation — `end <= start`, out-of-range minute, overlapping or touching entries, cross-midnight window, unknown IANA timezone | `errors[]` with `field` = `entries[i].startMinute` etc., one entry per offending value |
| `422` | `INVALID_SERVICE_AREA` | any S5 violation | `errors[]` with `field` = `areas[i].radiusKm` / `areas[i].cities` / `areas[i].centerAddressId` / `areas[i].serviceId` |
| `422` | `AVAILABILITY_NOTIFY_NOT_APPLICABLE` | a notification requested for a provider whose resolved state is already `available` | plain message; never a schedule detail |
| `403` | `FORBIDDEN` | an authenticated caller who is not the owning provider, or is in the wrong active mode (`requireActiveMode`) | `forbiddenError()` from `lib/api/errors.ts` |
| `404` | `NOT_FOUND` | unknown provider id, unknown override date, or a session user with no `provider_profiles` row | deliberately `404` rather than `403` for a non-existent provider, so ids cannot be probed |
| `409` | `CONFLICT` | stale `expectedVersion` on a schedule save (spec 003 AC-6 optimistic concurrency), or a `POST` override whose date already exists | the current `version` is returned so the client can refetch |
| `400` | `VALIDATION_ERROR` | malformed shape: missing field, wrong type, bad `YYYY-MM-DD`, malformed `serviceId` uuid, `to` before `from`, range wider than 62 days | spec 004 `errors[]` |

A duplicate `POST .../availability-notify` while one is still `pending` is **not** an error — it is
idempotent, returning `200` with the existing row (AC-6).

### Breaking-change check

- [x] N/A — new spec. `GET /providers/{id}/service-area-check` (spec 012) keeps its path, auth and
  response shape; only its previously inert result becomes real.

---

## 4. Data model changes

Drizzle ORM (`lib/db/schema.ts`), not Prisma. All three availability tables **already exist** as
spec 003 baselines carrying `id`/`created_at`/`updated_at`/`version`/`provider_profile_id` only, so
every row below extends an existing table rather than creating one — except the notification table.
The FK column is `provider_profile_id → provider_profiles.id`, never `provider_id`.

Existing schema constraints that apply (enforced by `lib/db/schema-lint.test.ts`, which this spec
must not break): no `numeric`/`real`/`double precision` column anywhere — so radius is stored as
**`radius_meters integer`**, not `radius_km numeric`, and schedule times are stored as **integer
minutes from local midnight**, not `time`; every timestamp is `timestamptz`; every FK is
`onDelete: 'restrict'` with its own covering btree index.

### Entities

| Entity | Change | Fields |
|---|---|---|
| `provider_profiles` | extend | `scheduling_timezone text not null default 'Asia/Karachi'` — R1's single per-provider IANA zone |
| `provider_services` | extend | `duration_minutes integer not null default 60` (§40 service-specific durations, R7); `buffer_before_minutes integer not null default 0`; `buffer_after_minutes integer not null default 0` (§40 buffer times, R8); CHECK `duration_minutes > 0` and both buffers `>= 0` |
| `provider_availabilities` | extend | `day_of_week integer not null`, `start_minute integer not null`, `end_minute integer not null`; CHECK `day_of_week between 0 and 6`, `start_minute between 0 and 1439`, `end_minute between 1 and 1440`, `start_minute < end_minute`; index `(provider_profile_id, day_of_week)`. R2's non-overlap holds across rows, so it is enforced by the transaction that atomically replaces the whole weekly set on `PUT`, not by a per-row constraint |
| `provider_availability_overrides` | extend | `date date not null`, `is_available boolean not null`, `start_minute integer null`, `end_minute integer null`; CHECK `(is_available = false) = (start_minute is null)`, the same null-pairing for `end_minute`, and `start_minute < end_minute` when set; unique `(provider_profile_id, date)` (R4) |
| `provider_service_areas` | extend | `service_id uuid null references services.id restrict`, `mode text not null`, `radius_meters integer null`, `center_address_id uuid null references addresses.id restrict`, `cities jsonb null`; CHECK `mode in ('radius','cities','remote')`, `mode = 'radius'` ⇒ `radius_meters` and `center_address_id` both non-null with `radius_meters between 1000 and 500000`, `mode = 'cities'` ⇒ `cities` non-null, `mode = 'remote'` ⇒ all three null; covering indexes on `service_id` and `center_address_id`; unique `(provider_profile_id, service_id)` plus a partial unique index on `provider_profile_id where service_id is null` (S1) |
| `provider_availability_notification_requests` | **new** | `...baseColumns()`, `customer_profile_id uuid not null references customer_profiles.id restrict`, `provider_profile_id uuid not null references provider_profiles.id restrict`, `status text not null default 'pending'` (`pending`/`sent`/`cancelled`), `notified_at timestamptz null`; a covering index on each FK; a partial unique index on `(customer_profile_id, provider_profile_id) where status = 'pending'` (AC-6's idempotency); CHECK on `status` |

The new table must also be added to `EXPECTED_TABLES` in `lib/db/schema-coverage.test.ts` in the
same PR — master spec §124 is explicitly a minimum list, and spec 003 AC-4 already allows a later
spec to add beyond it, as spec 009 did for `admin_role_assignments`.

**`bookings` is deliberately absent from the table above.** This spec adds **no column to
`bookings`** and touches no booking schema at all. Spec 003 AC-4 keeps every baseline table
"minimal/empty of feature columns **pending its owning spec**", and `bookings` is owned by
**approved spec 020**, whose own §4 already declares `scheduled_at` on `Booking`. A booking's
scheduled time and duration are part of booking creation, not of provider availability — see §3
"Interface with spec 020". The `duration_minutes` and buffer columns this spec *does* add live on
`provider_services`, which this spec legitimately owns as master spec §40's "service-specific
durations" and "buffer times"; they are a property of what the provider offers, not of any booking
row.

### Migration

- **Name:** `0012_add_provider_availability_service_areas`
- **Generated by:** `npm run db:generate` (drizzle-kit) from `lib/db/schema.ts`; applied by
  `npm run db:migrate` (`lib/db/migrate.ts`). The spec 003 baseline file
  (`drizzle/0001_baseline_schema.sql`) and its `.sha256` are **not** touched —
  `npm run check:schema-checksum` fails otherwise.
- **Reversible:** yes — a matching `_down.sql` following `0001_baseline_schema_down.sql`'s pattern.
- **Backfill required:** no. Every added column is nullable or defaulted, so existing rows stay
  valid (the baseline availability tables are empty in every environment).
- **Downtime:** none.
- **Reviewed SQL:** generated, reviewed in PR.
- **No `CREATE EXTENSION`** is issued — see §3 "Double-booking prevention".

### Retention and privacy

No customer personal data lives in the schedule or service-area tables; they are provider business
data keyed to `provider_profiles`. They integrate with **spec 008's existing** export/deletion
model rather than introducing a new mechanism:

- **Export** (`lib/privacy/export.ts`): `DataExportPayload` gains a `providerAvailability` section —
  weekly entries, overrides and service areas for the exporting user's own provider profile —
  fetched with an **explicit column allowlist** and an ownership-scoped join on
  `provider_profiles.user_id`, exactly as every existing section is. `center_address_id` is
  exported as the address id (already covered by spec 012's address data), never as raw
  coordinates. `provider_availability_notification_requests` is exported on the **customer** side
  (`customer_profiles.user_id`), since that is the row's data subject.
- **Deletion** (`lib/privacy/deletion.ts`): schedule, override and service-area rows carry no
  personal data once the existing sweep nulls `provider_profiles.business_name`, so they are
  retained keyed to the anonymized provider like every other provider-owned row. Pending
  `provider_availability_notification_requests` belonging to a deleting customer are moved to
  `cancelled` by that same sweep, so no notification is later sent to a deleted account.

No new privacy mechanism, export format, or deletion path is introduced.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | the schedule editor renders the DS `Skeleton` while `GET /providers/me/availability/schedule` and `.../service-areas` resolve; saving shows inline progress on the submit `Button`, never a full-page block |
| **Empty** | a provider with no weekly entries sees the DS `EmptyState` prompting schedule setup before going Active, with a CTA into the editor |
| **Error** | a `409 SLOT_OVERLAP` save shows the DS `Alert` naming the conflicting date and window; `422 INVALID_SCHEDULE_RANGE` / `INVALID_SERVICE_AREA` map each `errors[].field` onto that control's `FormField` error slot, preserving every entered value |
| **Success** | the saved schedule/override/area is reflected immediately in the editor and in every subsequent availability check; a DS `Toast` confirms |

Customer-facing availability (AC-5) always renders the state **with its `reason` text** beside it,
never a bare colour dot (master spec §3.5). It appears on the existing provider surfaces as a
`Badge` + text pair, and booking/offer actions render `disabled` with that same reason as their
accessible description, so the provider stays discoverable.

**Route(s) (this repo, not the template's `apps/web`):** `app/provider/schedule/page.tsx` —
replaces the existing spec-014 `PlaceholderPage`, whose own copy already names this spec. No new
route is added; the provider navigation already links here.

**Shared components:** all from the existing APURIVA Design System, imported from `@/components`
(never from `ui/` internals) and styled only with `app/styles/apuriva-tokens.css` tokens — no raw
colours, font sizes, radii, shadows or spacing. Already exported and used as-is: `Card`, `Button`,
`Badge`, `FormField`, `Input`, `Select`, `Switch`, `Checkbox`, `Table`, `Alert`, `Toast`,
`EmptyState`, `ErrorState`, `Skeleton`, `ConfirmDialog`, `Icon`, `Tag`.

**No `Calendar` component exists** anywhere in `ui/` or `components/` — the draft's "`packages/ui`
`Calendar`, `WeeklyScheduleEditor`" line was wrong on both the path and the components. The weekly
editor and override list are composed in `app/provider/schedule/_components/` from the primitives
above (a seven-row `Table` of `Select` time pairs, plus a list of override rows), the same way spec
012's `AddressForm` and spec 013's `SearchBar` were built. **No new design-system primitive is
introduced, no token is hand-overridden, and no already-shipped screen is redesigned by this spec.**

---

## 6. Test plan

**Vitest only.** This repository has **no Playwright or Cypress** — `package.json` installs
neither, and `vitest.config.ts` runs `e2e/*.spec.ts` as ordinary Vitest files (`e2e/auth.spec.ts`
is the only one today). The draft's `apps/web-e2e/availability.spec.ts` row is therefore removed
rather than promised, exactly as approved spec 015 §6 did.

Integration tests run against the isolated `<name>_test` database only (`vitest.config.ts` rewrites
`DATABASE_URL`; `test/db-reset.ts` refuses any other name) and follow the existing
`describe.skipIf(!dbReachable)` + transaction-rollback pattern from
`lib/db/status-transitions.integration.test.ts`. The concurrency test follows the **two-client**
pattern already established in `lib/db/concurrency.integration.test.ts`.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | R1–R9 resolution: override precedence, overlapping/touching rejection, cross-midnight rejection, invalid ranges, half-open slot boundaries, buffer widening, §42 state + reason derivation; S1–S5 row → `ServiceArea` mapping | `lib/availability/*.test.ts` |
| **Integration** | schedule/override/service-area CRUD, ownership and active-mode enforcement, optimistic-concurrency conflict, eligibility against real `requests`/`addresses`/`locations` rows, notify idempotency | `app/api/v1/providers/*.integration.test.ts` |
| **Concurrency** | `reserveProviderSlot` under two concurrent transactions against real `provider_profiles` rows, with busy intervals injected through the `BusyIntervalLoader` port — **no booking row is created or read**, since `bookings` has no scheduling columns until spec 020 adds them | `lib/availability/reserve.integration.test.ts` |
| **Component** | schedule editor loading/empty/error/success, override precedence display, disabled booking action with a visible reason | `app/provider/schedule/**/*.test.tsx` (Testing Library, jsdom) |
| **Privacy** | the export payload includes the provider's own schedule and excludes another user's; deletion cancels pending notification rows | `lib/privacy/export.integration.test.ts`, `lib/privacy/deletion.integration.test.ts` |

No test may assert behaviour only against a mock of the domain module: every rule above is
exercised through the real `lib/availability/*` code path and real database rows.

**Traceability** — every AC is covered, including AC-4, AC-6 and AC-7, which the draft omitted.

| AC | Test |
|---|---|
| AC-1 | `lib/availability/resolve.test.ts::an unavailable override replaces the weekly pattern for that date` and `::an available override defines the day's only window, never merged with the weekly rows` |
| AC-2 | `lib/availability/reserve.integration.test.ts::two concurrent transactions reserving the same overlapping slot — exactly one proceeds, the other gets 409 SLOT_OVERLAP` (two real pg clients against real `provider_profiles` rows, following `lib/db/concurrency.integration.test.ts`; busy intervals supplied through the `BusyIntervalLoader` port, so the test writes no booking row) and `::the provider lock is taken before the overlap read, inside the caller's transaction` |
| AC-3 | `app/api/v1/providers/service-area.integration.test.ts::excludes a request origin beyond a 20 km radius around the configured center address` |
| AC-4 | `app/api/v1/providers/service-area.integration.test.ts::a remote service is eligible for any origin while the provider's other services keep their radius area` |
| AC-5 | `app/api/v1/providers/availability-read.integration.test.ts::returns a state with a non-null reason and never exposes weekly rows, overrides, slots, bookings or timezone to a non-owner`, and `app/provider/schedule/AvailabilityBadge.test.tsx::renders the reason text beside the state and disables booking actions` |
| AC-6 | `app/api/v1/providers/availability-notify.integration.test.ts::creates a pending request (201), returns the same id on a repeat call (200), and rejects a notify for an available provider (422)` |
| AC-7 | `lib/availability/slots.test.ts::a slot adjacent to a busy interval within buffer_before/buffer_after is reported unavailable`, and `lib/availability/reserve.integration.test.ts::rejects a reservation that only overlaps a busy interval's buffer` |

**Coverage:** ≥80% on new code — the repository's established standard, unchanged.

**Not covered, deliberately:** travel-time-based dynamic availability adjustment and minimum-travel
requirements (master spec §41) — both depend on a travel-estimation capability spec 012 explicitly
put out of scope, with no vendor selected yet (spec 012 §8 risk #1).

---

## 7. Out of scope

- Booking creation/confirmation and **all** `Booking` schema, including its scheduling columns,
  are owned by **spec 020**. This spec only provides the availability data and the
  booking-agnostic `reserveProviderSlot()` primitive consumed by spec 020. It adds no column to
  `bookings`, issues no booking migration, and contains no booking SQL.
- The Postgres `EXCLUDE USING gist` constraint on confirmed bookings — **deferred hardening for
  spec 020**, once that spec fixes the booking status vocabulary such a constraint must be partial
  on, and once enabling `btree_gist` is confirmed acceptable in every environment. This is a
  decided deferral, not an open question: §3's transactional mechanism is the enforcement AC-2
  depends on.
- Matching's use of availability as a ranking *weight* (**spec 017**) — the hard eligibility check
  is this spec's concern; the ranking weight is spec 017's.
- Notification **delivery** for AC-6 (**spec 026**) — this spec records the opt-in row and the
  sweep hook; the channel, template and send path are spec 026's.
- Any change to the location vendor abstraction (**spec 012**) — this spec consumes `lib/location/*`
  and adds nothing to it.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Default buffer-before/after minutes per service type | Product | **Open — a product decision only, and non-blocking.** Implementation ships `buffer_before_minutes`/`buffer_after_minutes` defaulting to `0` and fully provider-configurable; a product answer later changes seed defaults, not the schema, the API, or any rule in §3 |
| 2 | Double-booking enforcement mechanism | Platform | **Resolved** — an application-level check inside the writing transaction, serialized by `SELECT ... FOR UPDATE` on `provider_profiles` (§3). The DB exclusion constraint is deferred to spec 020 as hardening (§7), for the reasons recorded there |
| 3 | Slot granularity | Platform | **Resolved** — a fixed 30-minute grid aligned to local midnight, with half-open intervals (§3 R7) |
| 4 | Per-row vs per-provider timezone | Platform | **Resolved** — one `provider_profiles.scheduling_timezone` per provider (§3 R1); the draft's per-row column is dropped |
| 5 | Cross-midnight windows | Platform | **Resolved** — rejected, and expressed as two same-day entries instead (§3 R5) |
| 6 | A provider edits their schedule under an already-confirmed booking | Platform | **Resolved** — the save runs through the same `BusyIntervalLoader` port and is rejected `409 SLOT_OVERLAP` naming the conflicting date and window; an existing booking is never silently invalidated. Live once spec 020 registers its loader; until then no booking with a scheduled time can exist, so there is nothing to strand (§3) |
| 7 | Spec 020's §4 declares `scheduled_at` with no companion IANA timezone column | Platform | **Reported, not changed here.** Spec 003 AC-2 requires any scheduled/appointment local time to store the original IANA identifier alongside the instant. Spec 020 is Approved and owns that table, so this spec does not edit it — it is raised for spec 020's implementation phase. Nothing in this spec depends on the resolution: `BusyInterval` carries UTC instants only |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** `0012_add_provider_availability_service_areas` ships with the code in the
  same deploy; every added column is nullable or defaulted, so ordering within the deploy does not
  matter.
- **Rollback:** revert the deploy and apply the migration's `_down.sql` (`npm run db:rollback`).
- **Observability:** `SLOT_OVERLAP` rejection rate, schedule-save error rate, and service-area
  exclusion rate monitored (master spec §117), emitted through the existing correlation-id-tagged
  API logging (spec 004).
