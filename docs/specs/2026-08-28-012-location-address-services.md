# Spec: Location & Address Services

**File:** `docs/specs/2026-08-28-012-location-address-services.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §8, §12, §132.19, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, §18, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No location abstraction exists. Master spec §8 requires a provider-agnostic location
layer (maps, geocoding, distance, service-area checks) that can be swapped without rewriting the
marketplace, and requires privacy-aware visibility: only approximate area before provider
selection, exact address only after booking.

**Who is affected:** Search/matching (013, 016), provider service areas (019), booking (020),
and messaging privacy (025) all depend on this abstraction rather than calling a maps API
directly.

**Why it matters now:** Search and matching cannot be built without a location layer; privacy
rules must be baked in from the start, not retrofitted.

**Success looks like:** A `packages/location` abstraction wraps geocoding/reverse-geocoding/
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
| AC-5 | **Given** a provider's declared service area (radius or specific cities) **When** a request originates outside it **Then** the provider is excluded from that request's eligible pool (feeds spec 016) |
| AC-6 | **Given** the underlying maps/geocoding provider **When** swapped for a different vendor **Then** no business logic outside `packages/location` requires changes |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/location/geocode` | session or guest | `200` `ApiResponse<GeocodeResultDto>` | address text → coordinates + hierarchy |
| `POST` | `/api/v1/location/reverse-geocode` | session or guest | `200` `ApiResponse<AddressDto>` | coordinates → address |
| `GET` | `/api/v1/addresses` | session | `200` `ApiResponse<AddressDto[]>` | user's saved addresses |
| `POST` | `/api/v1/addresses` | session | `201` `ApiResponse<AddressDto>` | |
| `GET` | `/api/v1/providers/{id}/service-area-check` | session or guest | `200` `ApiResponse<{ inServiceArea: boolean }>` | never returns provider's exact coordinates |

### Request and response types

```typescript
// packages/types/src/location.ts
export interface AddressDto {
  id: string;
  label: string;
  structured: { line1: string; area: string; city: string; country: string };
  latitude?: number; // present only when caller is authorized to see exact location
  longitude?: number;
  approxAreaLabel: string; // always safe to show
}
```

Backend enforces: `latitude`/`longitude` are stripped from any `AddressDto` serialized to a
caller not authorized for exact location (pre-booking customer view of a provider, or any
provider other than the one booked).

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `GEOCODING_FAILED` | upstream provider could not resolve the address |
| `403` | `EXACT_LOCATION_NOT_AUTHORIZED` | caller requested exact coordinates without booking-level authorization |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Location` | new | `id uuid pk`, `latitude numeric(9,6)`, `longitude numeric(9,6)`, `geo_hierarchy jsonb` (city/area/country), `created_at` |
| `Address` | new | `id uuid pk`, `user_id uuid fk->User`, `location_id uuid fk->Location`, `label text`, `structured jsonb`, `is_default boolean` |

Money/time conventions from spec 003 apply. `packages/location` is the only module permitted to
call the external maps/geocoding vendor; no other module holds vendor credentials.

### Migration

- **Name:** `AddLocationAddressTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Addresses are personal data — included in data export (spec 008), anonymized/deleted on account
deletion except where a completed booking's operational address must be retained for
dispute/audit purposes for the platform's retention window.

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
(`apps/web/app/account/addresses`)
**Shared components used/added:** `packages/ui` `Map` (thin wrapper around the abstracted
vendor), `AddressForm`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | exact-coordinate stripping logic based on caller authorization | `packages/location/**/*.test.ts` |
| **Integration** | geocode/reverse-geocode round trip (against sandbox/mock vendor); service-area-check | `apps/api/location/*.integration.test.ts` |
| **Component** | location-permission prompt states (allow/deny/manual) | `apps/web` (Testing Library) |
| **E2E** | user denies location, enters manual address, still gets search results | `apps/web-e2e/location.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/web-e2e/location.spec.ts::no prompt on first launch` |
| AC-3 | `packages/location/privacy.test.ts::strips exact coords pre-booking` |
| AC-4 | `apps/api/location/booking-address.integration.test.ts::exact address only to assigned provider` |
| AC-6 | `packages/location/vendor-abstraction.test.ts::swappable adapter interface` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Turn-by-turn navigation/travel-time estimation accuracy (depends
entirely on the chosen vendor's capability; only the abstraction contract is tested here).

---

## 7. Out of scope

- Provider service-area *configuration* UI (spec 019) — this spec provides the underlying
  geo/distance primitives it's built on.
- Search ranking by distance (spec 013/016) — this spec provides the distance-calculation
  primitive, not the ranking weight.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Maps/geocoding vendor selection (Google Maps, Mapbox, HERE, or a Pakistan-capable alternative) and credential availability | — | Open — requires real credentials or a documented sandbox/mock adapter per master spec §133.7 |

---

## 9. Rollout

- **Feature flag:** none — foundational for search/matching/booking.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; `packages/location` vendor adapter is swappable via config without
  a schema change.
- **Observability:** geocoding failure rate and vendor latency monitored (master spec §117).
