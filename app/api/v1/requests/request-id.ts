/**
 * Spec 015 §3 — `withApiRoute` (spec 004) forwards only `(request, correlationId)`, never Next's
 * route `context`, so a `{id}` route reads its own parameter from the URL. Shared by the three
 * `/requests/{id}*` routes rather than copied into each (the pattern
 * `app/api/v1/addresses/[id]/route.ts` established for a single route).
 *
 * `depthFromEnd` is how many segments sit after the id: `0` for `/requests/{id}`, `1` for
 * `/requests/{id}/cancel` and `/requests/{id}/cancel-preview`. Kept in a non-`route.ts` module so
 * the route files export nothing but their HTTP methods.
 */
export function requestIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
