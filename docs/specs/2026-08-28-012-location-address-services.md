# Spec: Location & Address Services

**File:** `docs/specs/2026-08-28-012-location-address-services.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §8, §12, §132.19, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, §18, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No location abstraction exists. Master spec §8 requires a provider-agnostic location
layer (maps, geocoding, distance, service-area checks) that can be swapped without rewriting the
marketplace, and requires privacy-aware visibility: only approximate area before provider
selection, exact address only after booking.

**Who is affected:** Search/matching (013, 017), provider service areas (016), booking (020),
and messaging privacy (025) all depend on this abstraction rather than calling a maps API
directly.

**Why it matters now:** Search and matching cannot be built without a location layer; privacy
rules must be baked in from the start, not retrofitted.

**Success looks like:** A `lib/location` abstraction wraps geocoding/reverse-geocoding/
distance/service-area checks behind an internal interface; exact coordinates are never exposed
to a customer before booking; the location-permission prompt only appears when it provides
value, never on first launch.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the app on first launch **When** it loads **Then** no location permission prompt appears; it only appears when the user reaches a screen where location adds value (e.g. "Find providers near you") |
| AC-2 | **Given** a user denies location **When** they continue **Then** they can enter a city/area/manual address and general discovery is not blocked |
| AC-3 | **Given** a customer browsing providers before selecting one **When** viewing a provider's location **Then** only an approximate area is shown, never exact coordinates |
| AC-4 | **Given** a confirmed booking **When** the operational address is needed **Then** the exact address becomes visible to the assigned provider only, not to other providers who submitted offers |
| AC-5 | **Given** a provider's declared service area (radius or specific cities) **When** a request originates outside it **Then** the provider is excluded from that request's eligible pool (feeds spec 017) |
| AC-6 | **Given** the underlying maps/geocoding provider **When** swapped for a different vendor **Then** no business logic outside `lib/location` requires changes |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/location/geocode` | session or guest | `200` `ApiResponse<GeocodeResultDto>` | address text → coordinates + hierarchy |
| `POST` | `/api/v1/location/reverse-geocode` | session or guest | `200` `ApiResponse<GeocodeResultDto>` | coordinates → address; returns the same shape as geocode, not a saved `AddressDto` (the point resolved has no saved-address `id`/`label` yet) |
| `GET` | `/api/v1/addresses` | session | `200` `ApiResponse<AddressDto[]>` | caller's own saved addresses |
| `POST` | `/api/v1/addresses` | session | `201` `ApiResponse<AddressDto>` | |
| `PATCH` | `/api/v1/addresses/{id}` | session, owner only | `200` `ApiResponse<AddressDto>` | update label / structured fields / `isDefault`; setting `isDefault: true` unsets it on the caller's other addresses |
| `DELETE` | `/api/v1/addresses/{id}` | session, owner only | `204` — | fails `409 ADDRESS_IN_USE` if a booking still references this address (baseline FK convention is `onDelete: 'restrict'`, never cascade — see §4) |
| `GET` | `/api/v1/providers/{id}/service-area-check?lat={number}&lng={number}` | session or guest | `200` `ApiResponse<{ inServiceArea: boolean }>` | `lat`/`lng` describe the candidate request origin (from a prior geocode call or GPS fix); never returns the provider's own exact coordinates |

`session or guest` has no existing helper in `lib/auth/` — every current route either calls
`requireSession` (`lib/auth/require-session.ts`) or skips auth entirely for a fully public route.
This spec introduces the first "optionally read a session, don't require one" route, needed so a
signed-in customer's saved addresses can be offered without blocking a guest.

All five routes must be added to `OPENAPI_ROUTES` in `lib/api/openapi-registry.ts` in the same PR
(enforced by `scripts/check-openapi-drift.ts`), and should rate-limit under a new `'location'`
`RateLimitDomain` in `lib/api/rate-limit.ts` rather than falling into `'default'` — geocode/
reverse-geocode calls reach a paid external vendor per request and warrant their own budget the
way `'search'` and `'payment'` already do.

### Request and response types

```typescript
// lib/types/location.ts
export interface GeocodeResultDto {
  structured: { line1?: string; area: string; city: string; country: string }; // line1 stripped like lat/lng, see below
  latitude?: number; // present only when caller is authorized to see exact location
  longitude?: number;
  approxAreaLabel: string; // always safe to show
}

export interface AddressDto {
  id: string;
  label: string;
  isDefault: boolean;
  structured: { line1?: string; area: string; city: string; country: string }; // line1 stripped like lat/lng, see below
  latitude?: number; // present only when caller is authorized to see exact location
  longitude?: number;
  approxAreaLabel: string; // always safe to show
}
```

Backend enforces: `latitude`, `longitude`, and `structured.line1` are stripped from any
`GeocodeResultDto`/`AddressDto` serialized to a caller not authorized for exact location
(pre-booking customer view of a provider, or any provider other than the one booked). Stripping
only `latitude`/`longitude` is not sufficient — an unredacted street-level `line1` still discloses
exact location without coordinates. An unauthorized caller receives only `structured.area`,
`structured.city`, `structured.country`, and `approxAreaLabel`.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `GEOCODING_FAILED` | upstream provider could not resolve the address |
| `403` | `EXACT_LOCATION_NOT_AUTHORIZED` | caller requested exact coordinates without booking-level authorization |
| `404` | `ADDRESS_NOT_FOUND` | `PATCH`/`DELETE` target does not exist or does not belong to the caller (not distinguished from not-found, per existing ownership-check convention) |
| `409` | `ADDRESS_IN_USE` | `DELETE` target is still referenced by a booking (`restrict` FK) |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

`locations` and `addresses` **already exist** as bare baseline tables from spec 003
(`lib/db/schema.ts:1447-1457`, shipped in `drizzle/0001_baseline_schema.sql`) — each currently
has only `id`/`created_at`/`updated_at`/`version`, plus (on `addresses`) nullable `user_id` and
`location_id` FKs. Per the `fileAssets` precedent in the same file ("stays exactly spec 003's
baseline shape" until the owning spec adds real columns), spec 012 owns adding `locations`' and
`addresses`' real columns — this is a column addition to existing tables, not new tables.

| Entity | Change | Fields |
|---|---|---|
| `Location` | extends spec 003 baseline table | adds `latitude_micro_degrees integer` (degrees × 1,000,000; range ±90,000,000), `longitude_micro_degrees integer` (±180,000,000), `geo_hierarchy jsonb` (city/area/country) |
| `Address` | extends spec 003 baseline table | adds `label text not null`, `structured jsonb not null`, `is_default boolean not null default false`; existing `user_id`/`location_id` FKs become `not null` |

`lib/db/schema-lint.test.ts` AC-1 bans `numeric`/`real`/`double precision` columns anywhere in
the schema (no exception for location data), so latitude/longitude cannot use `numeric(9,6)` as
originally drafted — they follow the same fixed-point-integer approach as `moneyColumns()`
(`*_amount_minor_units integer`), scaled to six decimal places of precision instead of minor
currency units. `geo_hierarchy` and `structured` are new jsonb columns, so both must be added to
`ALLOWED_JSONB_COLUMNS` in `schema-lint.test.ts` AC-5 in the same PR or CI fails (currently only
`security_events.metadata` is allow-listed).

**Booking-level exact-address authorization (AC-4) has no FK to hang off today.** Neither
`bookings` nor `offers` has any location/address reference (`lib/db/schema.ts:725-813`) — a
request also has no location FK yet. Spec 012 supplies the `Location`/`Address` primitive and the
authorization-check logic (`lib/location`), but the FK that actually scopes AC-4 —
`bookings.address_id uuid fk -> Address` (restrict, captured at booking confirmation, immutable
thereafter) — is spec 020's (booking creation) migration to add, since `bookings` is spec 020's
table. This is a cross-spec dependency spec 012 cannot resolve unilaterally; see §8.

Time conventions from spec 003 apply. `lib/location` is the only module permitted to call the
external maps/geocoding vendor; no other module holds vendor credentials.

### Migration

- **Name:** `AddLocationAddressColumns` (not `AddLocationAddressTables` — no table is created,
  only columns are added to the existing spec 003 baseline tables; same naming rule spec 005
  §4 already established for `AddAuthColumns`)
- **Reversible:** yes
- **Backfill required:** no — both tables currently have zero rows in every environment (nothing
  has ever written to them)
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Addresses are personal data — included in data export (spec 008). On account deletion, an address
with no booking referencing it may be hard-deleted. An address a completed booking still
references cannot be hard-deleted: every FK in this schema is `onDelete: 'restrict'` by baseline
convention (`schema-lint.test.ts` AC-4), so the database itself rejects deleting an `Address`/
`Location` row a booking still points to. For that case, "anonymized" means blanking `label` and
`structured`'s free-text fields in place while the row and the booking's FK persist — retaining
only what the dispute/audit trail needs (approximate hierarchy) for the platform's retention
window, never a full row delete.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | map/address skeleton while geocoding resolves |
| **Empty** | no saved addresses: "Add an address" prompt, manual entry always available as fallback to GPS |
| **Error** | geocoding failure: "We couldn't find that address — try a different search" with manual pin-drop fallback |
| **Success** | resolved address confirmed with an editable label before saving |

Location permission prompt copy matches master spec §12's example exactly in intent: clear
value statement, "Allow Location" and "Enter Area Manually" as equally prominent options — never
a dead-end if denied.

**Route(s):** embedded in search (013), booking (020), and account address management
(`app/account/addresses` — new; `app/account/` already exists with `privacy-security`, no
`addresses` page yet)
**Shared components used/added:** `components/Map.tsx`, `components/AddressForm.tsx` — new. `Map`
names a component spec 002 never implemented in `ui/` (see `components/index.ts`'s header
comment), and `AddressForm` is spec-012-specific, not a design-system primitive — both are built
directly in `components/` from existing tokens/primitives (`Input`, `FormField`, `Button`,
`Checkbox`), the same way spec 008's `ConfirmDialog` and spec 011's `PriceDisplay`/`FAQList`/
`PackageCard` are: genuinely reusable app-facing components with no `ui/` counterpart, not thin
re-exports of one

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | exact-coordinate + `line1` stripping logic based on caller authorization | `lib/location/**/*.test.ts` |
| **Integration** | geocode/reverse-geocode round trip (against sandbox/mock vendor); service-area-check; saved-address CRUD, ownership, and default-address behavior | `app/api/v1/location/*.integration.test.ts`, `app/api/v1/addresses.integration.test.ts` |
| **Component** | location-permission prompt states (allow/deny/manual) | the application (Testing Library) |
| **E2E** | user denies location, enters manual address, still gets search results | `e2e/location.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `e2e/location.spec.ts::no prompt on first launch` |
| AC-2 | `e2e/location.spec.ts::manual address entry when denied still returns results` |
| AC-3 | `lib/location/privacy.test.ts::strips exact coords and line1 pre-booking` |
| AC-4 | `app/api/v1/location/booking-address.integration.test.ts::exact address only to assigned provider` |
| AC-5 | `app/api/v1/providers/service-area-check.integration.test.ts::excludes provider whose service area does not cover the request origin` |
| AC-6 | `lib/location/vendor-abstraction.test.ts::swappable adapter interface` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Turn-by-turn navigation/travel-time estimation accuracy (depends
entirely on the chosen vendor's capability; only the abstraction contract is tested here).

---

## 7. Out of scope

- Provider service-area *configuration* UI (spec 016) — this spec provides the underlying
  geo/distance primitives it's built on.
- Search ranking by distance (spec 013/017) — this spec provides the distance-calculation
  primitive, not the ranking weight.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Maps/geocoding vendor selection (Google Maps, Mapbox, HERE, or a Pakistan-capable alternative) and credential availability | — | Open — requires real credentials or a documented sandbox/mock adapter per master spec §133.7 |
| 2 | AC-4's booking-scoped exact-address authorization depends on a `bookings.address_id` FK that only spec 020 (booking creation) can add, since `bookings` is spec 020's table | Spec 020 owner | Cross-spec dependency, not a spec 012 defect — flagged here so spec 020's data model explicitly picks this up; see §4 |

---

## 9. Rollout

- **Feature flag:** none — foundational for search/matching/booking.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; `lib/location` vendor adapter is swappable via config without
  a schema change.
- **Observability:** geocoding failure rate and vendor latency monitored (master spec §117).
