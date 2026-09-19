/**
 * Spec 029 §3 — `withApiRoute` (spec 004) forwards only `(request, correlationId)`, never Next's
 * route `context`, so a `{id}` route reads its own parameter from the URL. The same pattern
 * `app/api/v1/bookings/booking-id.ts` and `app/api/v1/providers/path-params.ts` established.
 *
 * `depthFromEnd` is `1` for `/reviews/{id}/response`, `/reviews/{id}/reports` and
 * `/admin/reviews/{id}/resolve`. Kept in a non-`route.ts` module so route files export nothing but
 * their HTTP methods.
 */
export function reviewIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
