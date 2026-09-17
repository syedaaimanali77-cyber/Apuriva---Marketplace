/**
 * Route registry — spec 004 AC-7. `GET /api/v1/openapi.json` (app/api/v1/openapi.json/route.ts)
 * generates its document from this list rather than a hand-written JSON file, and
 * `scripts/check-openapi-drift.ts` fails CI if a `route.ts` file under `app/api/v1/` exports an
 * HTTP method not listed here (or vice versa) — the two are required to stay in sync.
 *
 * Every domain spec (005 onward) that adds a route must add its entry here in the same PR.
 */
export interface OpenApiRouteEntry {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** OpenAPI-style path, e.g. `/health` or `/requests/{id}` — relative to `/api/v1`. */
  path: string;
  summary: string;
  tags: string[];
}

export const OPENAPI_ROUTES: OpenApiRouteEntry[] = [
  { method: 'GET', path: '/health', summary: 'Liveness/readiness check', tags: ['foundation'] },
  { method: 'GET', path: '/openapi.json', summary: 'Generated OpenAPI 3.x document', tags: ['foundation'] },
  { method: 'POST', path: '/auth/otp/request', summary: 'Request a phone OTP', tags: ['auth'] },
  { method: 'POST', path: '/auth/otp/verify', summary: 'Verify a phone OTP and establish a session', tags: ['auth'] },
  { method: 'POST', path: '/auth/register', summary: 'Register with email + password', tags: ['auth'] },
  { method: 'POST', path: '/auth/login', summary: 'Log in with email + password', tags: ['auth'] },
  { method: 'POST', path: '/auth/oauth/google', summary: 'Complete Google OAuth login', tags: ['auth'] },
  { method: 'POST', path: '/auth/oauth/apple', summary: 'Complete Apple OAuth login', tags: ['auth'] },
  { method: 'POST', path: '/auth/mfa/verify', summary: 'Complete an MFA-pending admin login', tags: ['auth'] },
  { method: 'POST', path: '/auth/logout', summary: 'Invalidate the current session', tags: ['auth'] },
  { method: 'POST', path: '/auth/step-up', summary: 'Issue a step-up token for a sensitive action', tags: ['auth'] },
  { method: 'GET', path: '/users/me', summary: 'Current user: profiles and session active mode', tags: ['users'] },
  {
    method: 'POST',
    path: '/users/me/provider-profile',
    summary: 'Become a provider (idempotent; does not switch mode)',
    tags: ['users'],
  },
  {
    method: 'PATCH',
    path: '/users/me/active-mode',
    summary: 'Switch the current session between customer/provider mode',
    tags: ['users'],
  },
  { method: 'GET', path: '/users/me/sessions', summary: "List the caller's own active sessions", tags: ['privacy'] },
  {
    method: 'DELETE',
    path: '/users/me/sessions/{id}',
    summary: 'Log out a single device (must belong to the caller)',
    tags: ['privacy'],
  },
  {
    method: 'DELETE',
    path: '/users/me/sessions',
    summary: 'Log out all other devices (current session survives); requires step-up',
    tags: ['privacy'],
  },
  {
    method: 'POST',
    path: '/users/me/data-export',
    summary: 'Request an asynchronous export of permitted personal data; requires step-up',
    tags: ['privacy'],
  },
  {
    method: 'GET',
    path: '/users/me/data-export/{id}',
    summary: 'Data export request status (and signed download URL once ready)',
    tags: ['privacy'],
  },
  {
    method: 'GET',
    path: '/users/me/data-export/{id}/download',
    summary: 'Signed, time-limited download of a ready data export',
    tags: ['privacy'],
  },
  {
    method: 'GET',
    path: '/users/me/deletion',
    summary: "Current account lifecycle status and pending deletion's grace-period end (if any)",
    tags: ['privacy'],
  },
  {
    method: 'POST',
    path: '/users/me/deletion',
    summary: 'Request account deletion (grace period; blocked by an active booking); requires step-up',
    tags: ['privacy'],
  },
  {
    method: 'POST',
    path: '/users/me/deletion/cancel',
    summary: "Cancel the caller's own pending deletion within the grace period",
    tags: ['privacy'],
  },
  { method: 'GET', path: '/users/me/mfa', summary: 'Current Security Center MFA on/off state', tags: ['privacy'] },
  {
    method: 'PATCH',
    path: '/users/me/mfa',
    summary: 'Toggle the Security Center MFA on/off control; requires step-up',
    tags: ['privacy'],
  },
  { method: 'GET', path: '/admin/roles', summary: 'List the seven canonical admin roles; Super Admin only', tags: ['admin-rbac'] },
  {
    method: 'POST',
    path: '/admin/users/{userId}/roles',
    summary: 'Assign an admin role to a user; Super Admin only, audited',
    tags: ['admin-rbac'],
  },
  {
    method: 'DELETE',
    path: '/admin/users/{userId}/roles/{role}',
    summary: 'Revoke an admin role from a user; Super Admin only, blocks the last remaining super_admin',
    tags: ['admin-rbac'],
  },
  {
    method: 'POST',
    path: '/admin/approvals/{actionId}/approve',
    summary: 'Approve a pending high/critical-risk AdminAction (second, distinct, authorized admin)',
    tags: ['admin-rbac'],
  },
  {
    method: 'POST',
    path: '/admin/approvals/{actionId}/reject',
    summary: 'Reject a pending high/critical-risk AdminAction',
    tags: ['admin-rbac'],
  },
  {
    method: 'GET',
    path: '/admin/approvals/pending',
    summary: "Pending AdminActions the caller is authorized to decide, scoped to their role(s)",
    tags: ['admin-rbac'],
  },
  {
    method: 'POST',
    path: '/admin/actions/{actionId}/post-action-review',
    summary: 'Record the mandatory post-action review for an emergency-bypassed AdminAction',
    tags: ['admin-rbac'],
  },
  {
    method: 'GET',
    path: '/admin/actions/pending-review',
    summary: 'AdminActions awaiting mandatory post-action review, scoped to the caller',
    tags: ['admin-rbac'],
  },
  { method: 'GET', path: '/categories', summary: 'List published categories (public)', tags: ['catalog'] },
  { method: 'GET', path: '/categories/{id}', summary: 'Published category detail, with published child subcategories (public)', tags: ['catalog'] },
  { method: 'GET', path: '/services/{id}', summary: 'Published service detail (public)', tags: ['catalog'] },
  { method: 'GET', path: '/admin/categories', summary: 'List all categories, any status; Content/Marketplace admin', tags: ['catalog'] },
  { method: 'GET', path: '/admin/categories/{id}', summary: 'Category detail, any status; Content/Marketplace admin', tags: ['catalog'] },
  { method: 'POST', path: '/admin/categories', summary: 'Create a category; Content/Marketplace admin', tags: ['catalog'] },
  { method: 'PATCH', path: '/admin/categories/{id}', summary: 'Edit a category (optimistic concurrency); Content/Marketplace admin', tags: ['catalog'] },
  { method: 'POST', path: '/admin/categories/{id}/retire', summary: 'Retire a category; blocked while active services remain attached', tags: ['catalog'] },
  { method: 'GET', path: '/admin/categories/{categoryId}/subcategories', summary: 'List subcategories under a category, any status; Content/Marketplace admin', tags: ['catalog'] },
  { method: 'POST', path: '/admin/categories/{categoryId}/subcategories', summary: 'Create a subcategory under an active category', tags: ['catalog'] },
  { method: 'GET', path: '/admin/subcategories/{id}', summary: 'Subcategory detail, any status; Content/Marketplace admin', tags: ['catalog'] },
  { method: 'PATCH', path: '/admin/subcategories/{id}', summary: 'Edit a subcategory (optimistic concurrency); Content/Marketplace admin', tags: ['catalog'] },
  { method: 'POST', path: '/admin/subcategories/{id}/retire', summary: 'Retire a subcategory; blocked while active services remain attached', tags: ['catalog'] },
  { method: 'GET', path: '/admin/services/{id}', summary: 'Service detail, any status; Content/Marketplace admin', tags: ['catalog'] },
  { method: 'POST', path: '/admin/services', summary: 'Create a service under a valid taxonomy path', tags: ['catalog'] },
  { method: 'PATCH', path: '/admin/services/{id}', summary: 'Edit a service (optimistic concurrency); Content/Marketplace admin', tags: ['catalog'] },
  { method: 'POST', path: '/admin/services/{id}/retire', summary: 'Retire a service (soft lifecycle change, not delete)', tags: ['catalog'] },
  { method: 'POST', path: '/admin/catalog/suggestions', summary: "Submit an AI catalog suggestion (spec 034); always pending_review, never mutates a catalog entity", tags: ['catalog'] },
  { method: 'GET', path: '/admin/catalog/pending-review', summary: 'List pending AI catalog suggestions; Content/Marketplace admin', tags: ['catalog'] },
  { method: 'POST', path: '/admin/catalog/pending-review/{id}/approve', summary: 'Approve a suggestion — creates the entity pending_review, never publishes directly', tags: ['catalog'] },
  { method: 'POST', path: '/admin/catalog/pending-review/{id}/reject', summary: 'Reject a suggestion — records reviewer/time, publishes nothing', tags: ['catalog'] },
  { method: 'GET', path: '/categories/{id}/page', summary: 'Aggregated category page data (public)', tags: ['service-page'] },
  { method: 'GET', path: '/services/{id}/page', summary: 'Aggregated service page data: fields, FAQs, packages, pricing (public)', tags: ['service-page'] },
  { method: 'GET', path: '/services/{id}/fields', summary: 'Field definitions consumed identically by the manual form and the AI (spec 034)', tags: ['service-page'] },
  { method: 'POST', path: '/admin/services/{id}/fields', summary: 'Define a service field; Content/Marketplace admin', tags: ['service-page'] },
  { method: 'POST', path: '/admin/services/{id}/faqs', summary: 'Add an official FAQ, published immediately; Content/Marketplace admin', tags: ['service-page'] },
  { method: 'POST', path: '/providers/me/services/{id}/faqs', summary: "Add the caller's own FAQ for a service they offer; session (provider, ownership-checked)", tags: ['service-page'] },
  {
    method: 'POST',
    path: '/admin/services/{id}/faqs/ai-suggestions/{suggestionId}/approve',
    summary: 'Publish an AI-drafted FAQ suggestion; Content/Marketplace admin, AI never publishes directly',
    tags: ['service-page'],
  },
  { method: 'POST', path: '/location/geocode', summary: 'Resolve address text to coordinates + hierarchy; session or guest', tags: ['location'] },
  { method: 'POST', path: '/location/reverse-geocode', summary: 'Resolve coordinates to an address; session or guest', tags: ['location'] },
  { method: 'GET', path: '/addresses', summary: "List the caller's own saved addresses", tags: ['location'] },
  { method: 'POST', path: '/addresses', summary: 'Save a new address for the caller', tags: ['location'] },
  { method: 'PATCH', path: '/addresses/{id}', summary: 'Update a saved address; owner only', tags: ['location'] },
  { method: 'DELETE', path: '/addresses/{id}', summary: 'Delete a saved address; owner only, blocked while a booking references it', tags: ['location'] },
  {
    method: 'GET',
    path: '/providers/{id}/service-area-check',
    summary: "Whether a candidate location falls within a provider's declared service area; session or guest",
    tags: ['location'],
  },
  { method: 'GET', path: '/home', summary: 'Customer-mode home feed (curated/recent/active-booking); session or guest', tags: ['home'] },
  {
    method: 'GET',
    path: '/users/me/personalization-settings',
    summary: "Current home-feed personalization opt-in/out state",
    tags: ['home'],
  },
  {
    method: 'PATCH',
    path: '/users/me/personalization-settings',
    summary: 'Opt out of/adjust home-feed personalization',
    tags: ['home'],
  },
  { method: 'GET', path: '/search', summary: 'Authoritative, paginated search results; session or guest', tags: ['search'] },
  {
    method: 'POST',
    path: '/search/interpret',
    summary: 'AI-assisted NL/voice-transcribed text -> structured search intent (never results); session or guest',
    tags: ['search'],
  },
  { method: 'GET', path: '/search/autocomplete', summary: 'Search suggestions; session or guest', tags: ['search'] },
  { method: 'POST', path: '/search/recent', summary: "Record a search to the caller's own recent-searches list", tags: ['search'] },
  // Spec 015 §3 — request creation & lifecycle.
  {
    method: 'POST',
    path: '/requests',
    summary: 'Create (draft -> submitted) a service request; requires Idempotency-Key',
    tags: ['requests'],
  },
  { method: 'GET', path: '/requests', summary: "List the caller's own requests (active|history)", tags: ['requests'] },
  { method: 'GET', path: '/requests/{id}', summary: "Read one of the caller's own requests", tags: ['requests'] },
  {
    method: 'GET',
    path: '/requests/{id}/cancel-preview',
    summary: 'Dry run: the consequence of cancelling, shown before confirmation',
    tags: ['requests'],
  },
  {
    method: 'POST',
    path: '/requests/{id}/cancel',
    summary: 'Cancel a request before provider selection',
    tags: ['requests'],
  },
  // Spec 016 §3 — provider availability & service areas. `/providers/{id}/availability` is the
  // only one of these a non-owner may call; everything under `/providers/me/**` is owner-only and
  // resolves the provider from the session, never from a client-supplied id.
  {
    method: 'GET',
    path: '/providers/{id}/availability',
    summary: 'Simplified customer-facing availability state and reason; session or guest',
    tags: ['availability'],
  },
  {
    method: 'POST',
    path: '/providers/{id}/availability-notify',
    summary: 'Opt in to be notified when an unavailable provider is free again; session (customer)',
    tags: ['availability'],
  },
  {
    method: 'GET',
    path: '/providers/me/availability/schedule',
    summary: "The caller's own weekly recurring schedule and scheduling timezone; session (provider)",
    tags: ['availability'],
  },
  {
    method: 'PUT',
    path: '/providers/me/availability/schedule',
    summary: 'Replace the weekly recurring schedule in one transaction; session (provider)',
    tags: ['availability'],
  },
  {
    method: 'GET',
    path: '/providers/me/availability/overrides',
    summary: 'Date-specific availability overrides in a date range; session (provider)',
    tags: ['availability'],
  },
  {
    method: 'POST',
    path: '/providers/me/availability/overrides',
    summary: 'Create a date-specific override; session (provider)',
    tags: ['availability'],
  },
  {
    method: 'PUT',
    path: '/providers/me/availability/overrides/{date}',
    summary: 'Update the override for a date; session (provider)',
    tags: ['availability'],
  },
  {
    method: 'DELETE',
    path: '/providers/me/availability/overrides/{date}',
    summary: "Remove a date's override, restoring the weekly pattern; session (provider)",
    tags: ['availability'],
  },
  {
    method: 'GET',
    path: '/providers/me/availability/slots',
    summary: 'Buffer-aware bookable slots for a service over a date range; session (provider), owner-only detail',
    tags: ['availability'],
  },
  {
    method: 'GET',
    path: '/providers/me/service-areas',
    summary: "The caller's own service-area configuration; session (provider)",
    tags: ['availability'],
  },
  {
    method: 'PUT',
    path: '/providers/me/service-areas',
    summary: 'Replace the whole service-area configuration in one transaction; session (provider)',
    tags: ['availability'],
  },
  // Spec 017 §3 — provider matching, ranking & distribution.
  {
    method: 'GET',
    path: '/requests/{id}/matches',
    summary: 'Admin-only ranking explainability: who was excluded/ranked and why (AC-6)',
    tags: ['matching'],
  },
  {
    method: 'GET',
    path: '/providers/me/requests',
    summary: "The caller's own distributed-to inbox; session (provider)",
    tags: ['matching'],
  },
  {
    method: 'GET',
    path: '/providers/me/requests/{id}',
    summary: 'One distributed request, with its available action; session (provider), distributed-to-only',
    tags: ['matching'],
  },
  {
    method: 'POST',
    path: '/providers/me/requests/{id}/accept',
    summary: 'Accept a distributed request (fixed/package/hourly only); enforces the single-claim invariant',
    tags: ['matching'],
  },
  {
    method: 'POST',
    path: '/providers/me/requests/{id}/decline',
    summary: 'Decline a distributed request; always available while actionable',
    tags: ['matching'],
  },
  {
    method: 'PATCH',
    path: '/admin/services/{id}/matching-weights',
    summary: 'Configure a service\'s ranking-weight/pool-size override; admin, risk-tier medium',
    tags: ['matching'],
  },
  {
    method: 'GET',
    path: '/admin/matching/suggestions',
    summary: 'List AI-proposed ranking-weight suggestions pending admin review (AC-7)',
    tags: ['matching'],
  },
  {
    method: 'POST',
    path: '/admin/matching/suggestions/{id}/approve',
    summary: "Approve a suggestion — applies its weights to the target service; admin, risk-tier medium",
    tags: ['matching'],
  },
  {
    method: 'POST',
    path: '/admin/matching/suggestions/{id}/reject',
    summary: 'Reject a suggestion — never applied; admin, risk-tier medium',
    tags: ['matching'],
  },
  // Spec 018 §3 — offer system & 2-minute timer. `/cron/offer-expiry-sweep` is excluded by the drift
  // check, like the other cron routes.
  {
    method: 'POST',
    path: '/offers',
    summary: 'Send an offer on a distributed quote/custom request; database-computed 2-minute window; requires Idempotency-Key',
    tags: ['offers'],
  },
  {
    method: 'GET',
    path: '/offers/{id}',
    summary: "One offer, with effective status; the request's customer or the offer's provider only",
    tags: ['offers'],
  },
  {
    method: 'POST',
    path: '/offers/{id}/accept',
    summary:
      'Accept a live offer (server clock strictly before expiresAt); single-accept invariant; requires Idempotency-Key; 409 OFFER_SUPERSEDED for a revised offer (spec 019)',
    tags: ['offers'],
  },
  {
    method: 'POST',
    path: '/offers/{id}/decline',
    summary: 'Decline a live offer; request owner only; 409 OFFER_SUPERSEDED for a revised offer (spec 019)',
    tags: ['offers'],
  },
  {
    method: 'POST',
    path: '/offers/{id}/withdraw',
    summary: "Withdraw the caller's own live offer before it expires; session (provider); 409 OFFER_SUPERSEDED for a revised offer (spec 019)",
    tags: ['offers'],
  },
  {
    method: 'GET',
    path: '/requests/{id}/offers',
    summary: "Every offer on the caller's own request, terminal ones included; session (customer)",
    tags: ['offers'],
  },
  // Spec 019 §3 — offer negotiation & comparison.
  {
    method: 'GET',
    path: '/requests/{id}/message-threads',
    summary: "Pre-selection threads the request's customer may see (providers with an offer or a message); session (customer)",
    tags: ['negotiation'],
  },
  {
    method: 'GET',
    path: '/requests/{id}/message-threads/{providerProfileId}/messages',
    summary: 'Messages in one pre-selection thread; readable after it closes; session (customer, request owner)',
    tags: ['negotiation'],
  },
  {
    method: 'POST',
    path: '/requests/{id}/message-threads/{providerProfileId}/messages',
    summary: 'Customer posts a request-specific message; contact details removed before storage; 5 per sender per thread per 10 min; requires Idempotency-Key',
    tags: ['negotiation'],
  },
  {
    method: 'GET',
    path: '/providers/me/requests/{id}/messages',
    summary: "The caller's own thread on a request distributed to them; session (provider)",
    tags: ['negotiation'],
  },
  {
    method: 'POST',
    path: '/providers/me/requests/{id}/messages',
    summary: 'Distributed provider posts a request-specific message (before or after offering); contact details removed; requires Idempotency-Key',
    tags: ['negotiation'],
  },
  {
    method: 'POST',
    path: '/offers/{id}/change-requests',
    summary: "Customer requests a change to the provider's current offer; never alters the offer or its timer; requires Idempotency-Key",
    tags: ['negotiation'],
  },
  {
    method: 'POST',
    path: '/offers/{id}/revisions',
    summary: 'Provider sends a revised offer: a NEW offer row with its own database-computed 2-minute window, audited in offer_revisions; requires Idempotency-Key',
    tags: ['negotiation'],
  },
  {
    method: 'GET',
    path: '/offers/{id}/revisions',
    summary: "The revision chain containing an offer; the request's customer or the offer's provider only",
    tags: ['negotiation'],
  },
  {
    method: 'GET',
    path: '/requests/{id}/offers/compare',
    summary: 'Compare 2–3 live offers with Top Match and rule-based reasons; available:false when not comparable; session (customer)',
    tags: ['negotiation'],
  },
  // Spec 020 §3 — booking creation & state machine.
  {
    method: 'POST',
    path: '/bookings',
    summary:
      'Create a booking from an accepted offer; full server-side revalidation inside one transaction; requires Idempotency-Key; 422 SLOT_NO_LONGER_AVAILABLE carries up to 3 re-submittable alternatives',
    tags: ['bookings'],
  },
  {
    method: 'GET',
    path: '/bookings',
    summary: "The caller's own bookings; the active mode selects customer or provider role; filter: upcoming/active/completed/cancelled/disputed",
    tags: ['bookings'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}',
    summary: 'One booking; either participant, in either mode; a non-participant gets 404, never 403',
    tags: ['bookings'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/status-history',
    summary: 'Every status transition with its actor ROLE and time (never a user id); either participant',
    tags: ['bookings'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/provider-en-route',
    summary: "Provider marks \"On my way\" (optional step); session (provider, the booking's own); 422 BOOKING_NOT_STARTABLE_YET more than 60 minutes early",
    tags: ['bookings'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/arrived',
    summary: "Provider marks \"I've Arrived\"; reachable from confirmed or provider_en_route; session (provider, the booking's own)",
    tags: ['bookings'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/start-service',
    summary: "Provider starts the service (arrived -> in_progress); session (provider, the booking's own)",
    tags: ['bookings'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/complete',
    summary:
      'Either participant marks an in-progress booking complete — no confirmation from the other party is required; requires Idempotency-Key; 422 COMPLETION_TOO_EARLY before the 60-second dwell',
    tags: ['bookings'],
  },
  // Spec 021 §3 — payment processing & protection. These routes sit in the bookings URL namespace
  // because a payment belongs to a booking, but they are spec 021's entirely; spec 020's own
  // modules and routes contain no payment reference. `/cron/payment-sweep` is excluded by the drift
  // check, like every other cron route.
  {
    method: 'POST',
    path: '/bookings/{id}/payment/authorize',
    summary:
      "Authorize (and capture) the booking's payment through the configured provider adapter; session (customer, the booking's own); requires Idempotency-Key; confirms the booking only on a provider-confirmed capture; 422 PAYMENT_FAILED otherwise",
    tags: ['payments'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/payment/capture',
    summary:
      "Capture a previously authorized payment; session (customer, the booking's own); requires Idempotency-Key; 409 PAYMENT_ALREADY_CAPTURED on a duplicate capture under a different key",
    tags: ['payments'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/payment',
    summary:
      "The booking's payment state — backend-confirmed only, never a provider reference; session (either participant, in their own mode)",
    tags: ['payments'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/price-adjustments',
    summary:
      "Provider proposes an additional charge; charges nothing; session (provider, the booking's own); requires Idempotency-Key",
    tags: ['payments'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/price-adjustments',
    summary: "Price adjustments proposed on a booking; session (either participant, in their own mode)",
    tags: ['payments'],
  },
  {
    method: 'POST',
    path: '/price-adjustments/{id}/approve',
    summary:
      'Customer approves an additional charge — the only path that may charge one, for exactly the amount and currency shown; requires Idempotency-Key; 409 ADJUSTMENT_ALREADY_RESOLVED on a concurrent decision',
    tags: ['payments'],
  },
  {
    method: 'POST',
    path: '/price-adjustments/{id}/reject',
    summary: 'Customer declines an additional charge; terminal, charges nothing; requires Idempotency-Key',
    tags: ['payments'],
  },
  // Spec 022 §3 — refunds. Approval listing and decisions reuse spec 009's existing
  // `/admin/approvals/*` routes; this spec adds none of its own. `/cron/refund-reconcile-sweep` is
  // excluded by the drift check, like every other cron route.
  {
    method: 'POST',
    path: '/bookings/{id}/refunds',
    summary:
      "Request the booking's policy refund; session (customer, the booking's own); requires Idempotency-Key; takes NO amount — the amount comes from spec 023's eligibility decision server-side; 422 REFUND_NOT_ELIGIBLE when no policy allows it",
    tags: ['refunds'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/refunds',
    summary:
      'Refunds issued on a booking — amounts, status and line reasons, never a provider reference or failure code; session (either participant, in their own mode)',
    tags: ['refunds'],
  },
  {
    method: 'POST',
    path: '/admin/refunds',
    summary:
      'Finance Admin refund override. Without adminActionId: initiates and returns 202 pending a second, distinct admin (risk tier high). With adminActionId: executes an approved override; 422 APPROVAL_REQUIRED while still pending. Requires Idempotency-Key',
    tags: ['refunds'],
  },
  {
    method: 'GET',
    path: '/admin/refunds',
    summary:
      'Finance Admin refund listing, paged and filterable by status and reconciliationState; requires the refunds/read permission',
    tags: ['refunds'],
  },
  // Spec 023 §3 — cancellation policy, cancellation and no-show. The response-timeout sweep
  // (`/cron/no-show-response-sweep`) is deliberately absent: cron routes are platform
  // infrastructure and are excluded from the drift check, as every existing cron route already is.
  {
    method: 'GET',
    path: '/services/{id}/cancellation-policy',
    summary:
      'The cancellation policy effective now for a service, after service/category/platform resolution; guest-readable',
    tags: ['cancellation'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/cancellation-policy',
    summary:
      "The policy version SNAPSHOTTED for this booking — never a re-resolution of current configuration, so a later policy change cannot alter an existing customer's terms; session (either participant)",
    tags: ['cancellation'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/cancel-preview',
    summary:
      'Read-only dry run of the cancellation consequence: tier, fee and refund, computed server-side, shown before confirmation; session (either participant)',
    tags: ['cancellation'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/cancel',
    summary:
      'Cancels a booking, computing the fee/refund server-side from the snapshotted policy version and handing the decision to spec 022. The body carries no amount, tier or timestamp. Requires Idempotency-Key',
    tags: ['cancellation'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/report-no-show',
    summary:
      'Reports that the other party did not attend. Creates a neutral report awaiting their response; applies no consequence and blames nobody. Requires Idempotency-Key',
    tags: ['no-show'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/no-show-reports',
    summary:
      "No-show reports on a booking, in the participant projection: neutral status only, never the other party's statement, the evidence bundle or the location signal",
    tags: ['no-show'],
  },
  {
    method: 'POST',
    path: '/no-show-reports/{id}/respond',
    summary:
      "The other party's response, which moves the report to under_review. Required before any consequence unless the response window elapses",
    tags: ['no-show'],
  },
  {
    method: 'POST',
    path: '/no-show-reports/{id}/withdraw',
    summary: 'The reporter retracting their own report, while it is still awaiting the other party’s response',
    tags: ['no-show'],
  },
  {
    method: 'GET',
    path: '/admin/no-show-reports',
    summary: 'Trust & Safety queue, filterable by status and outcome; requires the no_show_reports/read permission',
    tags: ['no-show'],
  },
  {
    method: 'GET',
    path: '/admin/no-show-reports/{id}',
    summary:
      'The full evidence bundle for review — the only surface exposing statements, evidence and the coarse location signal; requires the no_show_reports/read permission',
    tags: ['no-show'],
  },
  {
    method: 'POST',
    path: '/admin/no-show-reports/{id}/resolve',
    summary:
      'Trust & Safety resolution: an outcome from a closed set plus a required reason. The admin never chooses an amount — the consequence is computed from the booking’s snapshotted policy. Requires the no_show_reports/resolve permission',
    tags: ['no-show'],
  },
  {
    method: 'GET',
    path: '/admin/cancellation-policies',
    summary: 'Every cancellation policy scope with its current and historical versions; requires cancellation_policy/read',
    tags: ['cancellation'],
  },
  {
    method: 'POST',
    path: '/admin/cancellation-policies',
    summary:
      'Publishes a new immutable policy version for a scope, closing the previous one. Never an in-place edit, and effectiveFrom is the server’s clock. Requires cancellation_policy/configure',
    tags: ['cancellation'],
  },
  {
    method: 'PUT',
    path: '/providers/me/services/{id}/cancellation-option',
    summary:
      'Selects one of the allowed cancellation options the effective policy publishes for a service the caller offers. Accepts an option key, never a fee percentage or amount',
    tags: ['cancellation'],
  },
  // Spec 024 §3.12 — payouts & earnings. Approval listing and decisions reuse spec 009's existing
  // routes. The two cron routes are excluded from the drift check, like every cron route.
  {
    method: 'GET',
    path: '/providers/me/earnings',
    summary:
      'Provider earnings summary: gross, fee net of reversals, refunds, adjustments, net, pending, upcoming and paid, as server-side integer sums in one currency',
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/providers/me/earnings/lines',
    summary:
      'Booking-level earnings lines for the caller, paged and filterable by state, currency and date range',
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/providers/me/earnings/statement',
    summary:
      'Synchronous CSV earnings statement for a bounded date range and one currency; errors use the standard envelope',
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/providers/me/payouts',
    summary:
      "The caller's own payouts, paged and filterable by status",
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/providers/me/payouts/{id}',
    summary:
      "One of the caller's payouts with its items; another provider's payout is 404",
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/providers/me/payout-methods',
    summary:
      "The caller's payout methods, rail-supplied mask and institution label only",
    tags: ['payouts'],
  },
  {
    method: 'POST',
    path: '/providers/me/payout-methods',
    summary:
      "Registers a payout method from the rail's single-use setup token; requires step-up (manage_payout_method), CSRF and Idempotency-Key",
    tags: ['payouts'],
  },
  {
    method: 'PATCH',
    path: '/providers/me/payout-methods/{id}',
    summary:
      'Makes a verified payout method the default for its currency; requires step-up (manage_payout_method) and CSRF',
    tags: ['payouts'],
  },
  {
    method: 'DELETE',
    path: '/providers/me/payout-methods/{id}',
    summary:
      'Soft-removes a payout method and revokes it at the rail; requires step-up (manage_payout_method) and CSRF; refused while a payout still needs it',
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/admin/payouts',
    summary:
      'Finance Admin payout listing, paged and filterable by status, provider and date; requires payouts/read',
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/admin/payouts/{id}',
    summary:
      'Finance Admin payout detail with items; requires payouts/read, otherwise 404',
    tags: ['payouts'],
  },
  {
    method: 'POST',
    path: '/admin/payouts/{id}/retry',
    summary:
      'Initiates (202, second-admin approval required) or executes (with adminActionId) a retry of a failed payout; requires payouts/retry at risk tier high',
    tags: ['payouts'],
  },
  {
    method: 'POST',
    path: '/admin/earnings-adjustments',
    summary:
      'Initiates (202) or executes (with adminActionId, no amount) a credit/debit earnings adjustment bound to its approval; requires payouts/adjust at risk tier high',
    tags: ['payouts'],
  },
  {
    method: 'GET',
    path: '/admin/earnings-adjustments',
    summary:
      'Finance Admin adjustment listing, filterable by provider and applied state; requires payouts/read',
    tags: ['payouts'],
  },
  // Spec 025 §3 — post-booking messaging & conversations. Polling transport: no WS route is registered.
  {
    method: 'GET',
    path: '/bookings/{id}/conversation',
    summary:
      'The booking conversation (created on first access), with participants, isActive, contactSharingAllowed and unreadCount; either participant in their own mode; 404 CONVERSATION_NOT_FOUND for non-participants',
    tags: ['messaging'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/conversation/messages',
    summary:
      'Messages in created_at/id order, paged by limit/offset, or the delta read after=<createdAtISO>|<id> (not combinable with offset; optional telemetry resumed=<failedAttempts>:<gapSeconds>); readable while archived or blocked',
    tags: ['messaging'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/conversation/messages',
    summary:
      'Send a message (1-2000 chars); requires Idempotency-Key (replay 200, changed body 409 IDEMPOTENCY_KEY_CONFLICT); contact details masked before confirmation, flagged after; 403 BLOCKED, 422 CONVERSATION_ARCHIVED, 429 messaging rate limit',
    tags: ['messaging'],
  },
  {
    method: 'POST',
    path: '/bookings/{id}/conversation/read',
    summary:
      'Advance the last-read marker of the caller monotonically to lastReadMessageId; 422 MESSAGE_NOT_IN_CONVERSATION or CONVERSATION_ARCHIVED',
    tags: ['messaging'],
  },
  {
    method: 'GET',
    path: '/admin/conversations/{id}',
    summary:
      'Admin conversation metadata and participants (no bodies); requires messaging/read_conversation (support, trust & safety, super admin) and a 10-500 char reason query param; audited',
    tags: ['messaging'],
  },
  {
    method: 'GET',
    path: '/admin/conversations/{id}/messages',
    summary:
      'Admin paged message bodies; requires messaging/read_conversation and a 10-500 char reason query param; every page is audited',
    tags: ['messaging'],
  },
  // Spec 026 §3 — the caller's own notification centre and preferences. User-level (not mode-scoped); no
  // route creates a notification. The cron dispatch route is deliberately absent, like every cron route.
  {
    method: 'GET',
    path: '/users/me/notifications',
    summary: "Caller's own notifications, created_at DESC, id DESC; paged; ?unreadOnly=true",
    tags: ['notifications'],
  },
  {
    method: 'GET',
    path: '/users/me/notifications/unread-count',
    summary: "Count of the caller's unread notifications",
    tags: ['notifications'],
  },
  {
    method: 'POST',
    path: '/users/me/notifications/{id}/read',
    summary: "Mark one notification read (idempotent); another user's id is 404 NOTIFICATION_NOT_FOUND",
    tags: ['notifications'],
  },
  {
    method: 'POST',
    path: '/users/me/notifications/read-all',
    summary: "Mark all of the caller's unread notifications read; returns the count updated",
    tags: ['notifications'],
  },
  {
    method: 'GET',
    path: '/users/me/notification-preferences',
    summary: 'Resolved per-category channel preferences, non-overridable categories and marketing consent',
    tags: ['notifications'],
  },
  {
    method: 'PATCH',
    path: '/users/me/notification-preferences',
    summary:
      'Update per-category channels with the current version; 422 CATEGORY_NOT_OVERRIDABLE for security/payments/operational, 409 CONFLICT on a stale version',
    tags: ['notifications'],
  },
  {
    method: 'POST',
    path: '/users/me/marketing-consent',
    summary: 'Grant or withdraw marketing consent ({ consent: boolean }); idempotent; audited',
    tags: ['notifications'],
  },
];
