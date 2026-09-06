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
];
