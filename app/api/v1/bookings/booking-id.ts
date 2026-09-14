/**
 * Spec 020 §3 — `withApiRoute` (spec 004) forwards only `(request, correlationId)`, never Next's
 * route `context`, so a `{id}` route reads its own parameter from the URL. The same pattern
 * `app/api/v1/offers/offer-id.ts` and `app/api/v1/requests/request-id.ts` established.
 *
 * `depthFromEnd` is `0` for `/bookings/{id}` and `1` for
 * `/bookings/{id}/provider-en-route|arrived|start-service|complete|status-history`.
 */
export function bookingIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
