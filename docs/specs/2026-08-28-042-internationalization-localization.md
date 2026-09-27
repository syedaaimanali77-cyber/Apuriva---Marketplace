# Spec: Internationalization & Localization

**File:** `docs/specs/2026-08-28-042-internationalization-localization.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §3.6 (Urdu font stack), §5 (internationalization), §117 (observability), §120 (international expansion), §132 rule 19 (no Pakistan-specific core assumptions), §133 (avoid unnecessary dependencies), [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §16, §18, [docs/workflow.md](../workflow.md); specs 002 (design system, AC-6), 004 (API envelope), 005 (phone), 006 (`/users/me`), 008 (export/deletion), 012 (addresses), 013/033/034 (search and AI), 016 (scheduling timezone), 026 (notifications), 040 (analytics), 041 (feature flags). See §8.

---

## 1. Problem statement

**Today, the repository has these foundations** (verified):

- The Urdu font is installed. `app/fonts.ts` self-hosts Noto Nastaliq Urdu as `--font-urdu`, and
  `app/styles/apuriva-tokens.css` switches `--font-sans`, `--font-display` and the leading tokens on
  `[lang="ur"]`. This satisfies master §3.6 and spec 002's decided font stack.
- `app/globals.css` defines `[dir='rtl'] { --rtl-flip: scaleX(-1) }`.
- App CSS uses logical properties almost everywhere. There is one physical rule:
  `app/provider/schedule/schedule.module.css:64` (`text-align: left`).
- Server phone validation is plain E.164 (`lib/auth/phone.ts`).
- Addresses are a country-neutral free-text structure (`lib/location/addresses.ts`).
- Money is integer minor units with a `currency_code` on every value.

**These are missing:**

- `<html lang="en">` is hard-coded in `app/layout.tsx` and `app/global-error.tsx`, with no `dir`.
- There is no translation layer. Every UI string is inline English, including the English defaults
  inside `ui/` primitives ("Loading", "Try again", "Something went wrong", "Nothing to show",
  "Optional").
- There is no locale switcher, no locale persistence, and no `Accept-Language` handling.
- Only `ListRow` mirrors a directional icon; six customer pages render arrow and chevron icons that
  don't mirror.
- Money formatting is duplicated in 13 local helpers that divide by 100, which assumes two decimal
  places. 15 date/number calls hard-code `en-US`/`en-GB`, and about 29 files use the browser's locale.
- PKR appears as a literal fallback in business and UI logic:
  - `lib/payouts/read.ts` (`EMPTY_LEDGER_CURRENCY`);
  - `lib/payouts/statement.ts`;
  - `app/requests/new/[serviceId]/page.tsx` (`CURRENCY_CODE`);
  - the admin payout and refund filter defaults.
- Notification titles and bodies are rendered in English at creation and stored. Money `params`
  are pre-formatted in `en-US` (`lib/notifications/sinks.ts`).

**Who is affected:** Urdu-speaking customers, and anyone outside Pakistan later (master §120).

**Success looks like:**

- A customer can switch the in-scope customer journeys (§5) to Urdu. They get translated platform
  text, correct right-to-left layout from the first paint, and dates, numbers and money formatted
  for their locale.
- Roman Urdu input is never blocked or altered.
- No currency or country assumption is left hard-coded in core logic. Explicitly documented
  Pakistan-first *defaults* are kept.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** `urdu-locale` is on and the resolved locale is `ur` **When** any in-scope route (§5.1) renders **Then**: the platform text (navigation, labels, form text, system messages, known error codes, notifications) comes from the `ur` dictionary; `<html lang="ur" dir="rtl">` is set in the server-rendered HTML, so the first paint is right-to-left; directional icons mirror; the Urdu font stack applies. Admin-, provider- and user-authored content is shown as authored (§7). |
| AC-2 | **Given** Roman Urdu (or any script) typed into search, interpretation or AI chat **When** submitted under any locale **Then** it reaches the existing search and AI pipeline byte-for-byte: no locale code blocks, transliterates, normalizes or requires a locale switch. How well Roman Urdu is *understood* stays with specs 013, 033 and 034. |
| AC-3 | **Given** any in-scope money value **When** rendered **Then** it goes through the shared `formatMoney(amountMinorUnits, currencyCode, locale)`, which uses the value's own currency code and that currency's real fraction digits. No business or UI logic falls back to a PKR literal; the market default comes from `PLATFORM_CURRENCY_CODE` (§3.9). |
| AC-4 | **Given** the generic validation layer (phone: `lib/auth/phone.ts`; address: `lib/location/addresses.ts`) **When** a valid non-Pakistani phone number or address is submitted **Then** it is accepted by the same rules as a Pakistani one. No Pakistan-specific format is enforced server-side. |
| AC-5 | **Given** a new locale **When** it is added **Then** the only changes are one entry in `lib/i18n/config.ts`, a dictionary file, and (optionally) a Spec 041 availability flag. There is no schema change (`users.locale` checks only the tag's shape) and no business-logic change. |
| AC-6 | **Given** a key missing from the active dictionary **When** it is rendered **Then** the English text is shown, never the raw key, and one `i18n.missing_key` structured line is logged per key and locale per process. |
| AC-7 | **Given** a signed-in user **When** they save a locale **Then** it persists in `users.locale`, is returned by `GET /users/me`, wins over the cookie and `Accept-Language`, and appears in their spec 008 data export. Clearing it (`null`) returns them to cookie → `Accept-Language` → `en`. |
| AC-8 | **Given** `urdu-locale` is off (its initial value everywhere) **When** anyone resolves a locale **Then** `ur` is never selected: it isn't offered by `GET /locales`, `PATCH` refuses it, and a stored or cookie value of `ur` is treated as unset. Turning the flag on needs no deploy. |

### 2.1 AC implementation matrix

| AC | Path | Named test |
|---|---|---|
| AC-1 | `lib/i18n/server.ts` → `app/layout.tsx`; `LocaleProvider`; `--rtl-flip` icons | `app/layout.locale.test.tsx`, `components/rtl.test.tsx`, `app/rtl-scope.test.tsx` |
| AC-2 | no locale code on the input path | `lib/i18n/roman-urdu.regression.integration.test.ts` |
| AC-3 | `lib/i18n/format.ts`, `lib/config/currency.ts` | `lib/i18n/format.test.ts`, `lib/i18n/boundary.test.ts` |
| AC-4 | the unchanged generic validators | `lib/i18n/country-neutral.regression.test.ts` |
| AC-5 | `lib/i18n/config.ts`, the shape-only CHECK | `lib/i18n/config.test.ts`, `lib/i18n/migration.integration.test.ts` |
| AC-6 | `lib/i18n/translate.ts` | `lib/i18n/translate.test.ts` |
| AC-7 | `PATCH /users/me/locale`, `/users/me`, export | `app/api/v1/users/me/locale/route.integration.test.ts`, `lib/privacy/export.locale.integration.test.ts` |
| AC-8 | `resolveLocale()` plus the `urdu-locale` flag | `lib/i18n/resolve.test.ts`, `app/api/v1/locales/route.integration.test.ts` |

---

## 3. Architecture and API contract

### 3.1 Repository reality

This is a single Next.js 16 application. There is no `apps/*` or `packages/*`.

| What | Path |
|---|---|
| Locale code | `lib/i18n/**`, `lib/types/i18n.ts`, `lib/config/currency.ts` |
| Routes | `app/api/v1/locales/route.ts`, `app/api/v1/users/me/locale/route.ts` |
| Provider and switcher | `app/_components/LocaleProvider.tsx`, `app/_components/LocaleSwitcher.tsx` (placed on `app/account/page.tsx` and in the guest header) |
| Migration | `drizzle/0037_add_user_locale.sql` and `_down.sql` |
| Tests | Vitest: colocated `*.test.ts(x)`, `*.integration.test.ts` and `e2e/*.spec.ts` route-level specs |

**No new dependency** (master §133): no i18n library and no TMS. The translation and formatting
needs are fully met by typed TypeScript dictionaries plus the platform `Intl` APIs.

### 3.2 Locales: `lib/i18n/config.ts`

`SUPPORTED_LOCALES` is the only list of locales:

| code | label | nativeLabel | direction | intlLocale | availability flag |
|---|---|---|---|---|---|
| `en` | English | English | `ltr` | `en` | none (always available; the fallback) |
| `ur` | Urdu | اردو | `rtl` | `ur` | `urdu-locale` (Spec 041) |

- **Roman Urdu is not a locale** (master §5.1). It is input only (§3.10).
- `DEFAULT_LOCALE = 'en'`.
- `isLocaleTagShape(value)` accepts a BCP-47-shaped tag: `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`, at most
  35 characters.
- `isSupportedLocale(value)` checks membership in `SUPPORTED_LOCALES`.

### 3.3 Resolution: `lib/i18n/resolve.ts` (AC-7, AC-8)

`resolveLocale({ userLocale, cookieLocale, acceptLanguage, isAvailable })` is pure. It picks the
first **usable** candidate:

1. the saved `users.locale` (signed-in only);
2. the `apuriva_locale` cookie;
3. `Accept-Language`: languages in quality order, each reduced to its primary subtag;
4. `en`.

A candidate is **usable** when it is supported (`isSupportedLocale`) **and** available. `en` is
always available; `ur` only while `isFeatureEnabled('urdu-locale')` is true. An invalid,
unsupported or unavailable value is **treated as unset**, and resolution moves to the next source.
The function never throws.

`lib/i18n/server.ts` `getRequestLocale()`:

- is server-only;
- reads the cookie and `Accept-Language` through `next/headers`;
- reads the signed-in user's locale via the existing session cookie and store;
- checks the flag;
- returns `{ locale, direction }`.

### 3.4 Server-side `lang`/`dir`: first paint is correct (decision 3)

`app/layout.tsx` stays a server component:

- `await getRequestLocale()`;
- renders `<html lang={locale} dir={direction} className={brandFontVariables}>`;
- wraps the children in `<LocaleProvider locale={locale} messages={dictionary}>`.

The existing `[lang="ur"]` token block then applies the Urdu font stack. `[dir='rtl']` activates
`--rtl-flip`.

- **Consequence (accepted):** reading `cookies()`/`headers()` in the root layout opts every route
  into dynamic rendering (Next 16 `cookies.md`). No route is statically optimized today for
  locale-varying HTML.
- **`app/global-error.tsx`** is a client component that renders its own `<html>` and can't read
  request APIs. It reads `apuriva_locale` from `document.cookie`, and uses `en`/`ltr` when the
  cookie is missing or unusable.

### 3.5 Translation architecture (decision 2)

| File | Role |
|---|---|
| `lib/i18n/dictionaries/en.ts` | **Source of truth.** A nested `as const` object; `MessageKey` is the union of its dotted paths. |
| `lib/i18n/dictionaries/ur.ts` | Typed `DeepPartial<typeof en>`. A missing key is allowed (AC-6); an unknown key is a type error. |
| `lib/i18n/translate.ts` | `translate(locale, key, params?)`: the locale's string → the `en` string → never the raw key. It substitutes `{name}` placeholders and logs `i18n.missing_key` once per (locale, key) per process. |
| `app/_components/LocaleProvider.tsx` | A client context with `useLocale()` → `{ locale, direction, t }`. Only the resolved locale's dictionary is passed from the server. |
| `lib/i18n/errors.ts` | `translateApiError(locale, code, serverMessage)` (§3.7). |
| `lib/i18n/coverage.ts` | Lists the `en` keys missing from `ur`. It drives the §9 coverage checklist and its test. |

- Server components and route handlers call `translate()` directly.
- Client components use `useLocale().t`.

### 3.6 Formatting: `lib/i18n/format.ts` (AC-3, decision 9)

**Functions:**

- `formatMoney(amountMinorUnits, currencyCode, locale)`:
  - `Intl.NumberFormat(intlLocale, { style: 'currency', currency })`;
  - the divisor is `10 ** resolvedOptions().maximumFractionDigits`, so JPY uses 0 and KWD uses 3;
  - integers in, never float money arithmetic (master §132 rule 5);
  - an invalid code falls back to `<CODE> <amount>`.
- `formatNumber(value, locale)`.
- `formatDate(instant, locale, options)`, `formatTime(instant, locale, options)`, and
  `formatDateTime(...)` with an optional IANA `timeZone`.

**Replacements.** They replace:

- the 13 local money helpers;
- every `toLocale*`/`Intl.*` call in the in-scope files and shared components;
- the two server-side formatters (`lib/notifications/sinks.ts` `formatMinorUnits`,
  `lib/mcp-tools/display.ts`).

**Not replaced:** `Intl.DateTimeFormat('en-US', { timeZone })` used for **time-zone validation and
arithmetic**, not display:

- `lib/requests/create.ts` `isValidTimeZone`;
- `lib/availability/timezone.ts` (spec 016).

The `en-US` there is a fixed parsing locale, and changing it would be a bug. The boundary test
exempts exactly these two.

Admin screens stay English and call the same functions with `'en'`.

### 3.7 API errors (decision 4)

The spec 004 envelope is **unchanged**: a stable `code` plus an English `message` and field `errors`.
Only the client translates, through `translateApiError(locale, code, serverMessage)`:

- a known `code` (a key under `errors.<CODE>`) → the dictionary text;
- an unknown code → the server's `message`.

`VALIDATION_ERROR` field messages stay the server's. The form shows a translated generic line
("check the highlighted fields") above them. No server message is localized.

### 3.8 Notifications (decision 5)

The stored English `title`/`body` stay as the canonical record for export and history. They are no
longer the only rendering source.

- **Typed params.** `renderNotification(type, params, locale)` in `lib/notifications/catalogue.ts`
  takes typed param values. A money param is `{ amountMinorUnits, currencyCode }` and is formatted
  with `formatMoney` for the locale. Producers (`lib/notifications/sinks.ts`) pass raw values, never
  pre-formatted English.
- **Templates** per locale: `notifications.<type>.title|body` keys in the dictionaries.
- **Inbox reads** (`lib/notifications/inbox.ts`) re-render each row from `type` + stored `params`
  for the reader's resolved locale. A historical row whose params are plain strings renders with
  them as stored. The stored `title`/`body` are used only if the type is no longer in the catalogue.
- **Channel dispatch** (`lib/notifications/dispatch.ts`) renders per the recipient's resolved
  locale, which is their saved `users.locale`, else `en`, because there is no request context.

### 3.9 Market configuration: `lib/config/currency.ts` (decision 9)

- **`PLATFORM_CURRENCY_CODE`:** a new, documented `.env.example` variable, default `PKR`. This is
  the explicit Pakistan-first default, as configuration (master §5.2).
- `platformCurrencyCode()` validates ISO-4217 shape, and a bad value throws a configuration error
  (no silent fallback).
- **Replaces the PKR literals:**
  - `lib/payouts/read.ts` `EMPTY_LEDGER_CURRENCY`;
  - `lib/payouts/statement.ts` `?? 'PKR'`;
  - `app/requests/new/[serviceId]/page.tsx` `CURRENCY_CODE` (the client gets it from `GET /locales`,
    §3.11);
  - the `useState('PKR')` defaults in `app/admin/operations/payouts/page.tsx` and `refunds/page.tsx`.
- **Kept as they are (documented defaults or fixtures, not architecture assumptions):**
  - spec 016 `DEFAULT_SCHEDULING_TIMEZONE='Asia/Karachi'` and its schema default;
  - spec 033 `AI_COST_CURRENCY_CODE` (already env-configurable);
  - sandbox adapters' `PKR` (`lib/payments/provider/sandbox*.ts`, `lib/ai/provider/sandbox.ts`);
  - test fixtures;
  - marketing copy naming Pakistan (translated as copy).

### 3.10 Roman Urdu boundary (AC-2, decision 10)

- **Roman Urdu is input, never a locale.** No `lib/i18n` function reads, rewrites, transliterates,
  normalizes or validates free-text input.
- The search (`GET /search`, `POST /search/interpret`) and AI (`/ai/conversations/*`) request bodies
  and query strings are untouched by locale resolution.
- The UI locale and spec 034's AI memory `language` preference (`en` | `ur` | `ur-Latn`, the
  assistant's reply language) are **independent**. Neither sets the other.
- Spec 042 claims no Roman Urdu *understanding*. Today:
  - keyword search uses Postgres `english` full-text;
  - the sandbox interpreter matches English patterns.

  Understanding belongs to specs 013, 033 and 034.

### 3.11 Endpoints

| # | Method and route | Auth | Success |
|---|---|---|---|
| L1 | `GET /api/v1/locales` | none (guest or signed-in) | `200 ApiResponse<LocalesDto>` |
| L2 | `PATCH /api/v1/users/me/locale` | session + CSRF | `200 ApiResponse<UserLocaleDto>` |
| — | `GET /api/v1/users/me` (spec 006) | unchanged | `UserDto` gains `locale: string \| null` (additive) |

**Shared conventions:** `withApiRoute`, the `default` rate-limit bucket, `apiSuccess`, and an entry
in `lib/api/openapi-registry.ts` for L1 and L2. L1 is keyed by session user id, else
`hashRequestIp()`.

**L1: list locales.**

- Returns `{ locales, resolvedLocale, platformCurrencyCode }`.
- `locales` lists only **available** locales, in config order.
- `resolvedLocale` is the caller's current resolution.
- `platformCurrencyCode` is the §3.9 market default, used by the request form.
- `Cache-Control: no-store`.

**L2: set locale.** Body `{ locale: string | null }`.

- `null` clears the saved preference.
- Checks, in order:
  - not a string or null, or a bad tag shape → `400 VALIDATION_ERROR`;
  - not in `SUPPORTED_LOCALES` → `422 LOCALE_NOT_SUPPORTED`;
  - supported but its flag is off → `409 LOCALE_UNAVAILABLE`.
- On success:
  - updates `users.locale`;
  - sets the `apuriva_locale` cookie (`Path=/`, `SameSite=Lax`, one year, not `HttpOnly`, because
    the guest switcher writes it client-side too; the cookie holds only a locale tag);
  - logs `i18n.locale_changed` (from, to, source `account`, with no user id);
  - returns `{ locale, resolvedLocale, direction }`.
- A repeated identical request is a no-op success.

**Guests** switch by writing the cookie client-side; nothing is persisted server-side. Moderated
accounts may use L2 (the spec 038 allow-list idiom, like `/users/me`).

### 3.12 Types: `lib/types/i18n.ts`

```typescript
export type LocaleDirection = 'ltr' | 'rtl';
export interface LocaleDto { code: string; label: string; nativeLabel: string; direction: LocaleDirection }
export interface LocalesDto { locales: LocaleDto[]; resolvedLocale: string; platformCurrencyCode: string }
export interface UpdateUserLocaleRequest { locale: string | null }
export interface UserLocaleDto { locale: string | null; resolvedLocale: string; direction: LocaleDirection }
```

### 3.13 Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | L2 body not string/null, or a bad tag shape |
| `401` | `UNAUTHENTICATED` | L2 without a session |
| `403` | `CSRF_TOKEN_INVALID` / `FORBIDDEN` | the existing spec 005 CSRF refusal |
| `409` | `LOCALE_UNAVAILABLE` | supported locale whose availability flag is off |
| `422` | `LOCALE_NOT_SUPPORTED` | well-formed tag that isn't a supported locale |
| `429` | `RATE_LIMITED` | bucket exhausted |

### Breaking-change check

- [x] No route or envelope changes shape except the additive `UserDto.locale`.
- `renderNotification` gains a `locale` argument, and its callers change in the same PR. Money
  `params` change from pre-formatted strings to typed values for new rows only; old rows still
  render.

---

## 4. Data model changes

### `users.locale`: new column (spec 003 table)

| Column | Type | Notes |
|---|---|---|
| `locale` | `text NULL` | `NULL` = never explicitly chosen. CHECK `users_locale_shape_ck`: `locale IS NULL OR (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND char_length(locale) <= 35)`. Shape only, **no list of locales** (AC-5). Membership is validated in the application. |

### `urdu-locale`: Spec 041 registry (decision 7)

| Field | Value |
|---|---|
| owning spec | 042 |
| classification | business |
| client-readable | yes |
| kill switch | no |
| env override | none |
| defaults | **off** in development, staging and production |
| description | "Offers the Urdu UI locale; turn on only after the translation coverage checklist is complete (spec 042)." |

It is added to `lib/feature-flags/registry.ts` and seeded by migration 0037, following Spec 041
§3.3 ("one registry entry + a new migration that seeds its three environment rows").

### Migration

- **Files:** `drizzle/0037_add_user_locale.sql`, a hand-written `_down.sql`, and journal index 37.
  `lib/db/schema.ts` gains `users.locale` plus the CHECK.
- **Up:**
  1. `ALTER TABLE users ADD COLUMN locale text` and the CHECK.
  2. Insert the `urdu-locale` row into `feature_flags` with `ON CONFLICT ("key") DO NOTHING`.
  3. Insert its three `feature_flag_environment_values` rows (`enabled = false`) with
     `ON CONFLICT DO NOTHING`.
- **Down:** delete the three value rows and the flag row, then drop the CHECK and the column.
  Reversible.
- **Backfill:** none. `NULL` means "not chosen". **Downtime:** none; it's a nullable column.
  No money column is added, so the money lint is unaffected.

### Retention and privacy (decision 12)

- **Export:** `users.locale` is added to the spec 008 export's account section
  (`lib/privacy/export.ts`, the explicit `users` select at `:410` plus its type).
- **Deletion:** `users.locale` is set to `NULL` in the same anonymization update as `email` and
  `phoneNumber` (`lib/privacy/deletion.ts`).
- **The cookie** is a preference, not personal data.
- **Logs:** `i18n.locale_changed` carries no user id.

---

## 5. UI states

### 5.1 In-scope routes (decision 8). This is the definition of "every in-scope route" in AC-1.

**Shared chrome:**

- `app/layout.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/loading.tsx`, `app/not-found.tsx`;
- `app/components/AppHeader.tsx`, `NavShell.tsx`, `SideNav.tsx`, `BottomTabBar.tsx`, `nav-items.ts`;
- `app/account/_components/AccountMenu.tsx`, `ModeIndicator.tsx`;
- `app/_components/OnboardingOverlay.tsx`, `AuthGateResumer.tsx`, `AskApurivaPanel.tsx`,
  `FileUpload.tsx`, `MediaPreview.tsx`, `OfferCountdown.tsx`, `ReportReviewDialog.tsx`,
  `RequestMessageThread.tsx`, `UrgencyEmergencyNotice.tsx`, `BlockUserButton.tsx`,
  `PlaceholderPage.tsx`.

**Routes:**

| Area | Routes |
|---|---|
| Auth | `/login`, `/register` (`app/(auth)/**`, including `AuthShell.tsx`) |
| Home and explore | `/`, `/explore`, `/explore/[category]`, `/explore/[category]/[service]` |
| Search | `/search` |
| Requests and offers | `/requests`, `/requests/new/[serviceId]`, `/requests/[id]` (with `OffersPanel.tsx`, `MessageThread.tsx`), `/requests/[id]/compare` |
| Bookings | `/bookings`, `/bookings/[id]`, and its `/cancel`, `/dispute`, `/no-show`, `/payment` and `/review` sub-routes, plus `app/bookings/_components/*` |
| Account | `/account`, `/account/addresses`, `/account/notifications`, `/account/privacy-security`, `/account/ai-conversations`, `/account/ai-memory`, `/account/ai-activity`, `/account/moderation` |
| Support (customer-facing) | `/support`, `/support/new`, `/support/report`, `/support/tickets/[id]` |

**Out of scope (English only in this spec):**

- every `/admin/**` route;
- every `/provider/**` route.

Both still inherit the resolved `lang`/`dir` and the shared chrome. The provider schedule's one
physical CSS rule is still fixed, because it breaks right-to-left layout for anyone.

### 5.2 Components

**Wrappers (spec 002).** The thin `components/` re-exports of `ui/` primitives that carry English
defaults become real wrappers that pass `t()` defaults:

- `ErrorState` (title, retry label);
- `EmptyState`;
- `Skeleton` (the "Loading" label);
- `Table` (`emptyMessage`);
- `FormField` ("Optional");
- `SearchBar`, `AskApurivaPanel`, and the AI panel props.

`ui/` itself is generated and is **not** edited.

**Directional icons** get `transform: var(--rtl-flip, none)`. The design-system icon set has only
`arrow-right` and `chevron-right` as directional glyphs; `chevron-down` is not directional. They appear in:

- `app/account/page.tsx`;
- `app/explore/page.tsx`, `app/explore/[category]/page.tsx`;
- `app/requests/new/[serviceId]/page.tsx`, `app/requests/page.tsx`, `app/requests/[id]/page.tsx`;
- `ui` `EmptyState` and `ListRow`, which already flip.

The flip is done through a small `components/DirectionalIcon.tsx` wrapper around `Icon`, not by
editing `ui/`.

**Physical CSS:** `app/provider/schedule/schedule.module.css:64` changes `left` → `start`.

**Switcher:** `LocaleSwitcher` uses the existing `Select`, and shows only the locales L1 returns.
It sits on `/account` for signed-in users (calls L2) and in `AppHeader` for guests (writes the
cookie). After switching, it calls `router.refresh()`, so the server re-renders with the new
`lang`/`dir`: a soft refresh, not a full reload.

| State | Behaviour |
|---|---|
| **Loading** | the switcher is disabled while L2 is in flight, then refreshes |
| **Empty** | with only `en` available (flag off), the switcher is hidden |
| **Error** | L2 failure: the `Select` returns to its previous value, and a translated `Alert` shows `LOCALE_UNAVAILABLE`, etc. A missing key falls back to English (AC-6). |
| **Success** | text, `lang`, `dir`, fonts, directional icons, and date/number/money formats all switch |

---

## 6. Test plan

These use the real tools only: Vitest, Testing Library with jsdom, route/integration tests on the
isolated `*_test` database, and the route-level `e2e/*.spec.ts` style. **Not claimed:** browser
E2E, Playwright, screen-reader automation, axe, visual snapshots. None is installed; they belong to
specs 043/046.

| Level | What it covers | Where |
|---|---|---|
| Unit | `SUPPORTED_LOCALES` shape; tag shape; a new locale needs only config (AC-5) | `lib/i18n/config.test.ts` |
| Unit | the precedence order; invalid, unsupported or unavailable values treated as unset; `ur` never picked while the flag is off (AC-8); `Accept-Language` quality order | `lib/i18n/resolve.test.ts` |
| Unit | missing key → English, never the raw key; placeholders; one `i18n.missing_key` per key (AC-6) | `lib/i18n/translate.test.ts` |
| Unit | `formatMoney` fraction digits (PKR, USD, JPY, KWD), integers only, invalid code; date/number per locale (AC-3) | `lib/i18n/format.test.ts` |
| Unit | known error code → translated; unknown → the server message | `lib/i18n/errors.test.ts` |
| Unit | `PLATFORM_CURRENCY_CODE` default, validation and error | `lib/config/currency.test.ts` |
| Unit | coverage: keys missing from `ur` are listed; `ur` has no unknown keys (type-level and runtime) | `lib/i18n/coverage.test.ts` |
| Boundary | no PKR literal in production code except the §3.9 kept list; no `toLocale*`/`Intl.*` with a hard-coded locale in scope (except the two §3.6 time-zone modules); `lib/i18n` never touches search or AI input; no i18n dependency in `package.json`; `ui/` unchanged | `lib/i18n/boundary.test.ts` |
| Regression | Roman Urdu input byte-identical through `/search`, `/search/interpret` and `/ai/conversations/.../turns` under `en` and `ur` (AC-2) | `lib/i18n/roman-urdu.regression.integration.test.ts` |
| Regression | non-PK E.164 numbers and non-PK addresses accepted by the generic validators (AC-4) | `lib/i18n/country-neutral.regression.test.ts` |
| Integration | 0037 up/down, the shape CHECK accepts `en`/`ur`/`pt-BR` and rejects `EN`/`xx_1`, the flag seeded off | `lib/i18n/migration.integration.test.ts` |
| Routes | L1: guest and signed-in, available-only, `resolvedLocale`, `platformCurrencyCode`, `no-store`, OpenAPI | `app/api/v1/locales/route.integration.test.ts` |
| Routes | L2: every error code, persist and clear, cookie set, CSRF, 401, 429, OpenAPI; `/users/me` includes `locale` (AC-7) | `app/api/v1/users/me/locale/route.integration.test.ts` |
| Integration | export includes `locale`; deletion nulls it | `lib/privacy/export.locale.integration.test.ts` |
| Integration | notifications render per reader locale from type and params; money typed; old string params still render | `lib/notifications/locale.integration.test.ts` |
| Component | server layout sets `lang`/`dir` from the resolved locale | `app/layout.locale.test.tsx` |
| Component | wrappers render `t()` defaults; `DirectionalIcon` applies the flip under `dir="rtl"` | `components/rtl.test.tsx` |
| Component | a representative page per in-scope area renders Urdu text with no raw keys under `ur` | `app/rtl-scope.test.tsx` |
| Route-level | switch to `ur` (flag on), then search → request creation via the route handlers, with localized error codes resolvable | `e2e/i18n.spec.ts` |

**Other specs' tests** must stay green: specs 013, 033, 034, 026, 008, 006 and 041. The existing
Spec 041 tests that pin the registry at six flags are updated under X-15 (listed explicitly).

**Coverage:** ≥80% statements, branches, functions and lines on `lib/i18n/**` and
`lib/config/currency.ts`.

**Translation coverage checklist (§9):** `coverage.test.ts` reports every `en` key missing from
`ur`. A checklist in the implementing PR records that each §5.1 route was reviewed in `ur`.
`urdu-locale` may be turned on only when both are complete.

---

## 7. Out of scope

- **Content translation.** Catalog content (category, subcategory and service names; FAQs; field
  labels and options; package names and descriptions) displays in its authored language (decision
  1). So do provider-authored content (business names, offers, messages) and user-authored content
  (requests, reviews, tickets). Per-locale catalog translation is a follow-up spec.
- **Admin and provider screens** (§5.1). English only here.
- Locales beyond `en`/`ur`. The structure supports them (AC-5); none is built.
- URL-prefixed locales (`/ur/...`) and locale SEO (spec 044).
- Server-localized API messages (decision 4).
- AI-level Roman Urdu understanding (specs 013, 033, 034).
- A per-country validation framework. None is needed today (decision 11).
- Browser E2E, screen-reader and axe automation (specs 043/046).
- Machine translation at runtime.

---

## 8. Dependencies, decisions, risks

### Implementation precondition (decision W-1)

About 40 in-scope files currently carry **unrelated uncommitted work**, and several are **staged**
for earlier specs. These include:

- `app/components/NavShell.tsx`, `SideNav.tsx`, `AppHeader.tsx`;
- `app/account/_components/AccountMenu.tsx`, `ModeIndicator.tsx`, `useAccountUser.ts`;
- `app/account/page.tsx`, `app/page.tsx`, the `app/explore/**` and `app/search/**` pages;
- `app/error.tsx`, `app/loading.tsx`, `app/global-error.tsx`, `app/not-found.tsx`;
- `components/index.ts`, `FormField.tsx`, `SearchBar.tsx`, `PriceDisplay.tsx`, `PackageCard.tsx`,
  `ResultCard.tsx`, `IntentChip.tsx`, `ConfirmDialog.tsx`;
- `app/requests/api-client.ts`.

**Implementation starts only after that in-flight UI work is committed or otherwise resolved**, so
Spec 042 builds on a clean base and its commit contains only its own changes.

### Authorized cross-spec changes (X-list)

| # | Owning spec | File(s) | Change |
|---|---|---|---|
| X-1 | 002/014 | `app/layout.tsx`, `app/global-error.tsx` | server `lang`/`dir` plus `LocaleProvider` (§3.4) |
| X-2 | 002 | `components/ErrorState.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `Table.tsx`, `FormField.tsx`, `SearchBar.tsx`; new `components/DirectionalIcon.tsx`; `components/index.ts` | translated defaults; directional icon (§5.2) |
| X-3 | 004 | client callers of the API `message` in the §5.1 files; `app/requests/api-client.ts`, `app/bookings/booking-client.ts`, `app/_components/ask-apuriva-client.ts` | render via `translateApiError` (§3.7) |
| X-4 | 006 | `lib/types/users.ts`, `app/api/v1/users/me/route.ts` | add `UserDto.locale` |
| X-5 | 008 | `lib/privacy/export.ts`, `lib/privacy/deletion.ts` | export `locale`; null it on anonymization |
| X-6 | 026 | `lib/notifications/catalogue.ts`, `create.ts`, `inbox.ts`, `dispatch.ts`, `sinks.ts`; `lib/types/notifications.ts` | typed params, per-locale rendering (§3.8) |
| X-7 | 041 | `lib/feature-flags/registry.ts` | add `urdu-locale` (§4) |
| X-8 | 015 | `app/requests/new/[serviceId]/page.tsx` | currency from L1's `platformCurrencyCode` |
| X-9 | 024 | `lib/payouts/read.ts`, `lib/payouts/statement.ts` | `platformCurrencyCode()` instead of `'PKR'` |
| X-10 | 022/024 | `app/admin/operations/payouts/page.tsx`, `app/admin/operations/refunds/page.tsx` | filter default from L1; shared `formatMoney` |
| X-11 | 011/013/018–032 | the 13 local money helpers and the §3.6 formatter call sites: `app/admin/analytics/page.tsx`, `app/admin/settings/ai-usage/page.tsx`, `app/bookings/[id]/cancel`, `/dispute`, `/payment`, `/review` pages, `app/bookings/_components/RefundSection.tsx` and `ReviewSection.tsx`, `app/bookings/booking-client.ts`, `app/provider/earnings/earnings-client.ts`, `components/PackageCard.tsx`, `PriceDisplay.tsx`, `ReviewCard.tsx`, `lib/mcp-tools/display.ts`, `lib/offers/price-input.ts`, `app/admin/operations/disputes/page.tsx` | shared `format*` |
| X-12 | all UI specs | every §5.1 file | strings → `t()`; directional icons |
| X-13 | 016 | `app/provider/schedule/schedule.module.css` | `text-align: start` |
| X-14 | 001 | `.env.example` | `PLATFORM_CURRENCY_CODE=PKR`, documented |
| X-15 | 041 (tests) | `lib/feature-flags/registry.test.ts` (approved list), `lib/feature-flags/resolve.test.ts` and `lib/feature-flags/environment-isolation.integration.test.ts` (exact client-flag result), `lib/feature-flags/migration.integration.test.ts` (the "six flags" description; per-flag check against 0036 only for 0036's flags), `app/api/v1/admin/feature-flags/routes.integration.test.ts` (`toHaveLength(6)`) | accept the registered seventh flag. These are the only Spec 041 test edits; approved as part of this spec. |
| X-16 | 004 | `lib/api/openapi-registry.ts` | L1 and L2 |

### Decisions

| # | Decision |
|---|---|
| D-1 | MVP Urdu covers the platform UI only; authored content is shown as authored. |
| D-2 | In-repo typed TypeScript dictionaries; no i18n library, no TMS. |
| D-3 | `lang`/`dir` are set server-side in the root layout; every route renders dynamically. |
| D-4 | The API envelope is unchanged; the client translates by `code`, with the server message as fallback. |
| D-5 | Notifications render per reader locale from type and params; money params are typed. |
| D-6 | `users.locale` is nullable with a shape-only CHECK; precedence is user → cookie → `Accept-Language` → `en`; unusable values count as unset. |
| D-7 | `urdu-locale`: business, client-readable, not a kill switch, off everywhere. |
| D-8 | The customer-facing scope is §5.1; admin and provider are English only. |
| D-9 | Shared locale-aware formatting with real fraction digits; `PLATFORM_CURRENCY_CODE` replaces the PKR fallbacks; documented defaults are kept (§3.9). |
| D-10 | Roman Urdu is input only; locale code never touches input. |
| D-11 | E.164 and the country-neutral address structure are kept, with regression tests only. |
| D-12 | Export includes `locale`; deletion nulls it. |
| D-13 | Observability uses structured logs (`i18n.missing_key`, `i18n.locale_changed`). Spec 040's closed event list is not extended. |
| D-14 (W-1) | Implementation waits for the in-flight UI work to land. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Dynamic rendering for every route (D-3) | Accepted for correct first paint; spec 044 may revisit caching |
| R-2 | The Urdu translation quality and coverage effort | The flag is off until the checklist is complete (§6) |
| R-3 | Historical notifications keep English-formatted money strings | They render as stored; new rows are typed |
| R-4 | Server `VALIDATION_ERROR` field messages stay English | A translated summary line; field keys remain stable |
| R-5 | Global-error without request context | Cookie-based `lang`/`dir`, else `en` |

---

## 9. Rollout

- **Feature flag:** `urdu-locale` (Spec 041), **off** in every environment. A business admin turns
  it on per environment, with no deploy, once `coverage.test.ts` reports no missing `ur` keys and
  the §5.1 route checklist is signed off.
- **Order:** `0037` ships with the code. `.env.example` gains `PLATFORM_CURRENCY_CODE`.
- **Rollback:**
  - turn `urdu-locale` off: everyone resolves to `en` on the next request, with no deploy;
  - or revert the deploy;
  - `0037_…_down.sql` is optional and discards saved locale preferences.
- **Observability:** these structured lines (master §117):
  - `i18n.missing_key` (key, locale): a rising count means incomplete coverage;
  - `i18n.locale_changed` (from, to, source), with no user id.
