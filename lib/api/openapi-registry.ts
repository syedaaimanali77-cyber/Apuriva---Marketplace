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
  // Spec 028 §3 — service execution. Milestones and the evidence read surface only: the
  // arrival/start/completion transitions above are spec 020's and are reused, never duplicated.
  {
    method: 'POST',
    path: '/bookings/{id}/milestones',
    summary:
      "Provider posts an optional progress update (started/working/almost_done/custom + note); session (provider, the booking's own); requires Idempotency-Key; posts NO status change; 422 MILESTONE_NOT_ALLOWED_IN_STATUS outside arrived/in_progress",
    tags: ['bookings'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/milestones',
    summary: 'The booking\'s progress updates, oldest first; either participant, either mode',
    tags: ['bookings'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/evidence',
    summary:
      'Completion-evidence METADATA for the booking (bytes are fetched through GET /files/{id}); the provider any time, the customer only once the booking has reached completed — otherwise an empty list',
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
  // Spec 027 §3 — the file upload/delivery surface. User-level (not mode-scoped), except a
  // `message_attachment` read, which inherits spec 025's mode rule for the conversation it belongs
  // to. The cron maintenance sweep is deliberately absent, like every cron route.
  {
    method: 'POST',
    path: '/files/upload-url',
    summary:
      'Validate a declared file and reserve an upload target; Idempotency-Key required (409 IDEMPOTENCY_KEY_CONFLICT on a changed body)',
    tags: ['files'],
  },
  {
    method: 'POST',
    path: '/files/{id}/finalize',
    summary:
      'Confirm the stored object (actual size + magic-byte sniff), enter scanning; idempotent, owner only',
    tags: ['files'],
  },
  {
    method: 'GET',
    path: '/files/{id}',
    summary:
      'Issue a URL for a ready asset: a bound, expiring signed URL for private, a CDN URL with the delivery transform for public; 409 FILE_NOT_READY otherwise',
    tags: ['files'],
  },
  {
    method: 'GET',
    path: '/files/{id}/content',
    summary:
      "Signed-URL target: re-verifies the signature, its expiry AND the caller's authorization on every fetch",
    tags: ['files'],
  },
  {
    method: 'PUT',
    path: '/files/{id}/content',
    summary:
      "Upload target for the local storage adapter (signed with its own HMAC purpose); writes bytes only — it grants no readability, which only finalize can",
    tags: ['files'],
  },
  {
    method: 'DELETE',
    path: '/files/{id}',
    summary: "Soft-delete the caller's own asset; linkage rows survive and bytes are purged by the maintenance sweep",
    tags: ['files'],
  },
  // Spec 033 §3.2 — `lib/ai` is an internal library; this admin read is its only public REST
  // surface. The hourly `/cron/ai-usage-sweep` is deliberately absent, like every cron route.
  {
    method: 'GET',
    path: '/admin/ai/usage',
    summary: 'Aggregate AI usage, tokens and estimated cost by task and provider — never per-user, never prompt content',
    tags: ['ai'],
  },
  // Spec 034 §3.2 — Ask Apuriva. Every route requires a session (guests get 401 and nothing is stored).
  // The creating routes return 503 AI_PROVIDER_UNAVAILABLE when the assistant or platform AI is off;
  // every read, delete, the preference and export keep working (privacy rights are never flag-gated).
  {
    method: 'POST',
    path: '/ai/conversations',
    summary: 'Start an empty conversation; session + CSRF + Idempotency-Key (201 created, 200 replay, 409 changed body)',
    tags: ['ai'],
  },
  {
    method: 'GET',
    path: '/ai/conversations',
    summary: "The caller's own non-deleted conversations, most recently updated first; optional q searches message bodies (paged)",
    tags: ['ai'],
  },
  {
    method: 'DELETE',
    path: '/ai/conversations',
    summary: 'Clear history: tombstone every conversation and delete its messages; activity and AI memory are kept',
    tags: ['ai'],
  },
  {
    method: 'DELETE',
    path: '/ai/conversations/{id}',
    summary: 'Delete one conversation (messages removed, activity and memory kept); not owned is 404',
    tags: ['ai'],
  },
  {
    method: 'GET',
    path: '/ai/conversations/{id}/messages',
    summary: 'The transcript in created_at, id order (paged); not owned or deleted is 404',
    tags: ['ai'],
  },
  {
    method: 'POST',
    path: '/ai/conversations/{id}/messages',
    summary:
      'One turn; Idempotency-Key (201, 200 replay). Returns the reply, optionally with a memoryProposal (never stored) or a pendingConfirmation. A degradable AI failure (429/503) stores nothing',
    tags: ['ai'],
  },
  {
    method: 'POST',
    path: '/ai/conversations/{id}/confirm',
    summary:
      'Explicitly confirm a medium/high-risk action by confirmationId; Idempotency-Key. 404 for any id until specs 035/036 register an executor; a stale confirmation passes spec 035 error through',
    tags: ['ai'],
  },
  {
    method: 'POST',
    path: '/ai/temporary-turns',
    summary:
      'One temporary/private turn: conversation-only and server-stateless. Stores nothing, proposes no memory, executes no action; no Idempotency-Key',
    tags: ['ai'],
  },
  { method: 'GET', path: '/ai/memory', summary: "The caller's AI memory (at most one entry per allow-listed key)", tags: ['ai'] },
  {
    method: 'POST',
    path: '/ai/memory',
    summary:
      'Explicitly confirm a proposed memory item { conversationId, key, value }; keys preferred_category, preferred_area, language only (400 otherwise). 201 created, 200 replaced',
    tags: ['ai'],
  },
  { method: 'DELETE', path: '/ai/memory', summary: 'Reset AI memory (every entry); conversations are untouched', tags: ['ai'] },
  { method: 'DELETE', path: '/ai/memory/{id}', summary: 'Delete one AI memory entry; not owned is 404', tags: ['ai'] },
  {
    method: 'GET',
    path: '/ai/suggestions',
    summary:
      'Current proactive suggestions (upcoming_booking, unfinished_request), derived at read time; navigation-only, never an action; [] when turned off',
    tags: ['ai'],
  },
  {
    method: 'GET',
    path: '/ai/activity',
    summary: "The caller's AI activity history, newest first, in plain language — never a raw tool identifier (paged)",
    tags: ['ai'],
  },
  { method: 'GET', path: '/users/me/ai-preferences', summary: 'Read the proactive-suggestions preference', tags: ['ai'] },
  {
    method: 'PATCH',
    path: '/users/me/ai-preferences',
    summary: 'Turn every proactive suggestion on or off; system notifications are unaffected',
    tags: ['ai'],
  },
  // Spec 029 §3 — reviews & ratings. The public list returns `published` AND `flagged` reviews and
  // carries no `status` field, so a flagged review is indistinguishable from a published one to a
  // reader (AC-4/AC-5); only an authorized human moderation decision can hide anything.
  {
    method: 'POST',
    path: '/bookings/{id}/reviews',
    summary:
      "Customer reviews their own completed booking (rating 1-5, optional text, optional ready review_media); session (customer, the booking's own); requires Idempotency-Key; 422 BOOKING_NOT_ELIGIBLE_FOR_REVIEW before completion, 422 REVIEW_WINDOW_CLOSED after the window, 409 REVIEW_ALREADY_EXISTS on a duplicate or concurrent race",
    tags: ['reviews'],
  },
  {
    method: 'GET',
    path: '/bookings/{id}/reviews',
    summary:
      'Server-authoritative review eligibility for the booking (eligible, reason, windowClosesAt) plus the review if one exists; either participant, either mode — a client never computes the deadline itself',
    tags: ['reviews'],
  },
  {
    method: 'GET',
    path: '/providers/{id}/reviews',
    summary:
      "A provider's visible reviews, newest first; session or guest. Returns published AND flagged (never removed), carries no reviewer identity and no status field",
    tags: ['reviews'],
  },
  {
    method: 'POST',
    path: '/reviews/{id}/response',
    summary:
      "The provider's single immutable reply; session (provider, owner of the reviewed provider profile); requires Idempotency-Key; 409 RESPONSE_ALREADY_EXISTS on a second attempt, 422 REVIEW_NOT_RESPONDABLE on a removed review",
    tags: ['reviews'],
  },
  {
    method: 'POST',
    path: '/reviews/{id}/reports',
    summary:
      "Report a review for moderation (closed reason set; details required for 'other'); any authenticated user except the author; requires Idempotency-Key; a repeat replays the reporter's existing report with 200; NEVER changes the review's visibility",
    tags: ['reviews'],
  },
  {
    method: 'GET',
    path: '/admin/reviews/moderation-queue',
    summary:
      'Flagged reviews and reviews with open reports, oldest first; admin (reviews/read_moderation_queue — Trust & Safety, Super Admin). Everything listed is already publicly visible; listing hides nothing',
    tags: ['reviews'],
  },
  {
    method: 'POST',
    path: '/admin/reviews/{id}/resolve',
    summary:
      'The ONLY route that can remove a review: keep/remove/reinstate with a required reason and expectedStatus; admin (reviews/moderate, medium tier); audited in-transaction; 409 CONFLICT when another admin already resolved it',
    tags: ['reviews'],
  },
  // Spec 030 §3 — blocking, reporting & safety incidents. NOTE WHAT IS ABSENT: there is no
  // restriction route. Spec 030 owns no enforcement action; restrictions are spec 038's, reached
  // from the resolve route through an unregistered port that refuses until 038 ships (DECIDED-3).
  {
    method: 'POST',
    path: '/blocks',
    summary:
      "Block another user; session, either mode. Named by targetUserId in the body because this repository has no users/{id} convention. Prevents future messaging in BOTH directions and excludes the pair from future matching; never alters an existing booking or hides message history. A duplicate replays 200",
    tags: ['safety'],
  },
  {
    method: 'GET',
    path: '/blocks',
    summary:
      "The caller's own blocks, newest first. There is deliberately no 'who blocked me' route anywhere: telling someone they were blocked hands a harasser a signal to act on",
    tags: ['safety'],
  },
  {
    method: 'DELETE',
    path: '/blocks/{id}',
    summary:
      'Unblock; session. Idempotent — removing a block that is not there is 204. Sending is restored immediately because the gate reads user_blocks live on every send',
    tags: ['safety'],
  },
  {
    method: 'POST',
    path: '/safety-reports',
    summary:
      'File a safety report about another user; session, either mode, never a guest; requires Idempotency-Key. The body carries NO priority: nothing classifies a report automatically, so every report starts at one constant and only a Trust & Safety admin moves it. The reported user is never notified',
    tags: ['safety'],
  },
  {
    method: 'GET',
    path: '/safety-reports/{id}',
    summary:
      "The reporter's own restricted view (id, status, category, createdAt, own attachments). Carries no priority, no AI summary, no admin identity and no resolution reason. Anyone else — including the reported user — gets 404, never 403",
    tags: ['safety'],
  },
  {
    method: 'GET',
    path: '/admin/safety-reports',
    summary:
      'The Trust & Safety queue, priority DESC then created_at ASC (FIFO among equals); admin (safety_reports/read — Trust & Safety, Super Admin only; support_admin is excluded). The read itself is audited',
    tags: ['safety'],
  },
  {
    method: 'GET',
    path: '/admin/safety-reports/{id}',
    summary:
      'One report in full, including the advisory AI summary; admin (safety_reports/read). Audited separately from the queue, because who opened a given report is a different fact from who scanned the list',
    tags: ['safety'],
  },
  {
    method: 'POST',
    path: '/admin/safety-reports/{id}/claim',
    summary:
      'Claim a report into under_review and record the owning admin; admin (safety_reports/resolve). No reason required — claiming changes no outcome',
    tags: ['safety'],
  },
  {
    method: 'POST',
    path: '/admin/safety-reports/{id}/escalate',
    summary:
      'Escalate to a different set of eyes; admin (safety_reports/escalate, medium). Reason required. Changes WHO LOOKS, never what happens to anyone',
    tags: ['safety'],
  },
  {
    method: 'POST',
    path: '/admin/safety-reports/{id}/resolve',
    summary:
      'Close a report with a required reason and expectedStatus; admin (safety_reports/resolve, medium). resolved is terminal. requestRestriction asks SPEC 038 through a port that is unregistered here, so it returns 422 RESTRICTION_UNAVAILABLE and leaves the report open and the account untouched rather than fabricating an enforcement outcome',
    tags: ['safety'],
  },
  {
    method: 'POST',
    path: '/admin/safety-reports/{id}/priority',
    summary:
      'Set a report priority by hand; admin (safety_reports/resolve). The ONLY way a priority ever moves — nothing derives one from content. Audited with both the old and the new value',
    tags: ['safety'],
  },

  // Spec 031 §3 — disputes & resolution. NOTE WHAT IS ABSENT: there is no route here that creates a
  // refund, moves a payout or calls a payment provider. A resolution PROPOSES an amount; spec 022's
  // `POST /admin/refunds` (tier `high`, second-admin approval) is the only way money ever moves.
  {
    method: 'POST',
    path: '/bookings/{id}/disputes',
    summary:
      'Open a dispute on a booking; session, either participant, either mode; requires Idempotency-Key. Eligible ONLY while the booking is protected and its payment protection is held — i.e. inside spec 021 payment-protection window. Atomically creates the dispute, moves the booking protected->disputed and the payment protection held->disputed, which is what holds the payout',
    tags: ['disputes'],
  },
  {
    method: 'GET',
    path: '/disputes',
    summary: "The caller's own disputes, newest first; session. Scoped by join, so it can only ever return disputes they are party to",
    tags: ['disputes'],
  },
  {
    method: 'GET',
    path: '/disputes/{id}',
    summary:
      "The participant's view: status, reason, both sides' counts, the resolution WITH its reasoning, any appeal and the appeal deadline. Carries no counterparty user id, no admin identity, no AI summary, no refund approval chain, no safety cross-reference and no legal-hold flag. A non-participant gets 404, never 403",
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/disputes/{id}/evidence',
    summary:
      'Link an already-finalized spec 027 file asset to the dispute; session, participant; requires Idempotency-Key. Bytes never pass through this route — upload and finalize are spec 027, under the dispute_evidence context this spec registers',
    tags: ['disputes'],
  },
  {
    method: 'GET',
    path: '/disputes/{id}/evidence',
    summary:
      'The evidence list. BOTH participants see both sides (deliberately unlike spec 030) — a party who cannot see what is argued against them cannot appeal. An admin with disputes/read also sees it, and that read is audited',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/disputes/{id}/messages',
    summary:
      'Post to the dispute thread; session participant, or admin with disputes/resolve (flagged isAdmin); requires Idempotency-Key. Contact details are FLAGGED, never masked — a dispute is always post-confirmed, so spec 025 own rule keeps the body verbatim as a T&S signal. Append-only: no edit, no delete',
    tags: ['disputes'],
  },
  {
    method: 'GET',
    path: '/disputes/{id}/messages',
    summary:
      'The thread, oldest first, so it reads as a record. Both participants read all of it; an admin with disputes/read reads it audited. No read receipts and no unread counts — those are spec 025 conversation features and are not reproduced',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/disputes/{id}/appeal',
    summary:
      'Appeal a resolution; session, EITHER participant (not only the opener); requires Idempotency-Key. At most one per dispute and only within DISPUTE_APPEAL_WINDOW_DAYS of resolved_at. Moves resolved->appealed, which is still not closed, so the money stays held. Nobody is notified',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/disputes/{id}/waive-appeal',
    summary:
      'Give up the right to appeal and close the dispute early; session, participant; requires Idempotency-Key. Releases the booking and the payment protection back to spec 021 so the provider is paid without waiting out the window. Refused 422 DISPUTE_REFUND_PENDING while a proposed refund has not completed',
    tags: ['disputes'],
  },
  {
    method: 'GET',
    path: '/admin/disputes',
    summary:
      'The Trust & Safety dispute queue, live disputes first then created_at ASC (FIFO among equals); admin (disputes/read — Operations, Trust & Safety, Super Admin; finance_admin is excluded). The read itself is audited',
    tags: ['disputes'],
  },
  {
    method: 'GET',
    path: '/admin/disputes/{id}',
    summary:
      'One dispute in full, the only shape carrying real identities, the advisory AI summary, the refund approval chain, the safety cross-reference and the legal-hold flag; admin (disputes/read). An admin who is a party to the booking is refused 403 DISPUTE_PARTICIPANT_CONFLICT, reads included. Audited separately from the queue',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/admin/disputes/{id}/claim',
    summary:
      'Claim a dispute into under_review and record the owning admin; admin (disputes/resolve). Optional — open->resolved is legal too. No reason required: claiming changes no outcome',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/admin/disputes/{id}/resolve',
    summary:
      'Record the decision and its mandatory reasoning; admin (disputes/resolve, medium — Trust & Safety per master §69). MOVES NO MONEY: a refund decision stores a PROPOSED amount only, bounded by spec 022 readRefundablePosition under the payment lock. The dispute becomes resolved, not closed, so the payout stays held through the appeal window',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/admin/disputes/{id}/link-refund',
    summary:
      'Record the adminActionId that spec 022 POST /admin/refunds returned, connecting the proposal to its approval chain; admin (disputes/resolve). Stores an admin_actions id, never a refunds id — no refund row exists until a second admin approves. At most one chain per resolution, so a duplicate refund request cannot be attached',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/admin/disputes/{id}/appeal-decision',
    summary:
      'Decide the appeal; admin (disputes/review_appeal, medium) whose user id MUST differ from the original resolver, else 403 APPEAL_REQUIRES_DIFFERENT_ADMIN. The original resolution is never edited. The decision is final and closes the dispute; a still-moving refund defers only the closure, never the recorded decision',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/admin/disputes/{id}/legal-hold',
    summary:
      'Set or clear the legal hold on a dispute evidence; admin (disputes/resolve). Reason required, both directions audited. Reuses the existing file_assets.legal_hold flag spec 027 purge sweep already honours — no second hold mechanism. Never set automatically by any rule',
    tags: ['disputes'],
  },
  {
    method: 'POST',
    path: '/admin/disputes/{id}/escalate-safety',
    summary:
      'File a spec 030 safety report about a participant of this dispute; admin holding BOTH disputes/resolve and safety_reports/read; requires Idempotency-Key. Calls spec 030 own creation path — sets no priority, applies no restriction, writes no lifecycle_status. One-way: spec 030 never opens a dispute. The dispute is not paused',
    tags: ['disputes'],
  },
  // ---------------------------------------------------------------------------
  // Spec 032 - customer & provider support. NOTE WHAT IS ABSENT: no route here resolves a
  // dispute, creates a refund, applies a sanction or decides a safety matter. Support owns
  // the conversation; the hand-off route points at the spec that owns the outcome and stops.
  // ---------------------------------------------------------------------------
  {
    method: 'POST',
    path: '/support/assistant',
    summary:
      'Ask the AI assistant a common question; session + CSRF; ai rate-limit domain (NOT support), so assistant traffic can never consume the budget needed to reach a human. Creates nothing, so no Idempotency-Key. ALWAYS 200 with escalationAvailable true - a disabled assistant, rate limit, exhausted quota, outage or any other failure degrades to a null answer rather than an error. Nothing is stored: no prompt column, no response column',
    tags: ['support'],
  },
  {
    method: 'POST',
    path: '/support/tickets',
    summary:
      'Raise a support ticket; session + CSRF + Idempotency-Key. Optional contextType/contextId (booking, payment or dispute), re-authorized server-side through the owning spec own helper; every failure is a uniform 422 SUPPORT_CONTEXT_NOT_AVAILABLE so the id space cannot be enumerated. There is NO priority field: priority is derived from the category by a fixed table, and sending one is 400',
    tags: ['support'],
  },
  {
    method: 'GET',
    path: '/support/tickets',
    summary:
      'The caller own support tickets, newest first; session. Scoped by requester_user_id in the query itself, so it cannot widen',
    tags: ['support'],
  },
  {
    method: 'GET',
    path: '/support/tickets/{id}',
    summary:
      'One of the caller own tickets; session. A non-requester gets 404, never 403. Participant projection only: no assigned admin, no AI summary, no SLA clock, no legal hold, no escalation pointer id, no idempotency column',
    tags: ['support'],
  },
  {
    method: 'POST',
    path: '/support/tickets/{id}/messages',
    summary:
      'Post to the ticket thread; session + CSRF + Idempotency-Key. One route, two authorization paths: the requester posts as themselves (and a post while awaiting_user also ends the SLA pause), an admin holding support/respond posts flagged is_admin and may set requestsInformation to move assigned to awaiting_user. Contact details are flagged for Trust and Safety, never masked',
    tags: ['support'],
  },
  {
    method: 'GET',
    path: '/support/tickets/{id}/messages',
    summary:
      'The ticket thread, OLDEST FIRST; the requester or an admin holding support/read. Each message is projected to a relative author (you or support), so a requester never learns which individual replied. No read receipts and no unread counts - those are spec 025 conversation features and are not reproduced here',
    tags: ['support'],
  },
  {
    method: 'POST',
    path: '/support/tickets/{id}/reopen',
    summary:
      'Reopen a resolved ticket; session (requester) + CSRF + Idempotency-Key. Once only (409 SUPPORT_REOPEN_LIMIT_REACHED) and inside SUPPORT_REOPEN_WINDOW_DAYS (422 SUPPORT_REOPEN_WINDOW_ELAPSED). Withdraws the resolution rather than keeping it beside a live ticket',
    tags: ['support'],
  },
  {
    method: 'POST',
    path: '/support/tickets/{id}/close',
    summary:
      'Accept the resolution and close the ticket; session (requester) + CSRF + Idempotency-Key. closed is TERMINAL - no route in this spec leaves it, for any actor',
    tags: ['support'],
  },
  {
    method: 'GET',
    path: '/admin/support/tickets',
    summary:
      'The unified support inbox; admin (support/read - support_admin, operations_admin, super_admin). Filters: status, priority, category, assignedToMe, slaBreached. Default sort is SLA deadline ascending. slaBreached is COMPUTED, never stored, and an awaiting_user ticket is never breached however old its deadline, because the clock is paused',
    tags: ['admin'],
  },
  {
    method: 'GET',
    path: '/admin/support/tickets/{id}',
    summary:
      'One ticket in full; admin (support/read). Emits the support.ticket_read audit event - reading decides nothing but is still attributable. Carries the whole of master section 63 list, with booking/payment/dispute as a POINTER plus one neutral status string and a link into the owning spec own permissioned surface; this spec widens no existing exposure',
    tags: ['admin'],
  },
  {
    method: 'POST',
    path: '/admin/support/tickets/{id}/assign',
    summary:
      'Claim or reassign a ticket; admin (support/assign); requires Idempotency-Key. The SLA deadline is NOT reset - a new assignee inherits it, so passing a ticket around cannot erase a breach. The target must hold support/respond, else 422 SUPPORT_ASSIGNEE_NOT_ELIGIBLE',
    tags: ['admin'],
  },
  {
    method: 'POST',
    path: '/admin/support/tickets/{id}/priority',
    summary:
      'Change a ticket priority; admin (support/triage, medium); reason required; requires Idempotency-Key. The ONLY way priority moves after creation, and it is human-set - nothing reads the ticket content to derive it. Audits both the old and the new value, and recomputes the SLA deadline from created_at plus the accumulated pause',
    tags: ['admin'],
  },
  {
    method: 'POST',
    path: '/admin/support/tickets/{id}/notes',
    summary:
      'Add an internal note; admin (support/respond); requires Idempotency-Key. Stored in support_notes, NEVER as a row in support_messages, so no projection bug in the thread query can leak one to the requester',
    tags: ['admin'],
  },
  {
    method: 'GET',
    path: '/admin/support/tickets/{id}/notes',
    summary:
      'The internal notes, oldest first; admin (support/read). Admin-only by route placement AND by permission; no participant code path reads this table at all',
    tags: ['admin'],
  },
  {
    method: 'POST',
    path: '/admin/support/tickets/{id}/resolve',
    summary:
      'Resolve a ticket; admin (support/resolve, medium); reason required (it is shown to the requester); requires Idempotency-Key. resolutionKind is answered, handed_off or not_actionable. A safety-category ticket can NEVER be resolved answered - refused by the application and independently by support_tickets_safety_resolution_ck',
    tags: ['admin'],
  },
  {
    method: 'POST',
    path: '/admin/support/tickets/{id}/reopen',
    summary:
      'Reopen a resolved ticket; admin (support/resolve); reason required; requires Idempotency-Key. Inside the same window as the requester own reopen, but it does NOT consume it',
    tags: ['admin'],
  },
  {
    method: 'POST',
    path: '/admin/support/tickets/{id}/close',
    summary:
      'Close a resolved ticket; admin (support/resolve); requires Idempotency-Key. Notifies nobody - the requester was told at resolution and closure asks nothing further of them',
    tags: ['admin'],
  },
  {
    method: 'POST',
    path: '/admin/support/tickets/{id}/hand-off',
    summary:
      'Hand a ticket to the spec that owns its outcome; admin (support/resolve); reason required; requires Idempotency-Key. Files a spec 030 safety report through spec 030 own path, records the id of a dispute a participant already opened through spec 031 own route, or records that the matter is Finance. Sets legal_hold. Applies no sanction, creates no refund, resolves no dispute, writes no lifecycle_status - and nothing comes back',
    tags: ['admin'],
  },
  // Spec 035 §3 "Admin surface" — the MCP tool registry. Metadata only: no tool input, no output
  // and no call history (the persisted tool-call log is spec 036's, and so is any view of it).
  {
    method: 'GET',
    path: '/admin/mcp/tools',
    summary:
      'List registered MCP tools and what each may do; admin (mcp/read_registry, Super Admin only). Metadata only - name, risk tier, plain-language label, reversibility, allowed modes, confirmation and idempotency declarations. Empty until the tool catalogue spec registers tools',
    tags: ['admin'],
  },
];
