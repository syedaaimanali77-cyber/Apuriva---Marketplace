/**
 * Spec 016 §3 — `withApiRoute` (spec 004) forwards only `(request, correlationId)`, never Next's
 * route `context`, so a `{id}`/`{date}` route reads its own parameter from the URL. The same
 * pattern `app/api/v1/requests/request-id.ts` established for spec 015, and the one spec 012's
 * `service-area-check` route already inlines.
 *
 * `depthFromEnd` is how many segments sit after the wanted one: `0` for the last segment, `1` for
 * `/providers/{id}/availability`, `2` for `/providers/{id}/availability/x`. Kept in a
 * non-`route.ts` module so route files export nothing but their HTTP methods.
 */
export function segmentFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
