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
];
