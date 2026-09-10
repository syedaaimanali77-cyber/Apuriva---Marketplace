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
];
