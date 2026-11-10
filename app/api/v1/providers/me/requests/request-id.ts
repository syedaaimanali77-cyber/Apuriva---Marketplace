/**
 * Spec 017 §3 — same pattern as `app/api/v1/requests/request-id.ts` (spec 015): `withApiRoute`
 * forwards only `(request, correlationId)`, never Next's route `context`, so a `{id}` route reads
 * its own parameter from the URL. Shared by the three `/providers/me/requests/{id}*` routes.
 *
 * `depthFromEnd` is how many segments sit after the id: `0` for `/providers/me/requests/{id}`,
 * `1` for `/providers/me/requests/{id}/accept` and `/providers/me/requests/{id}/decline`.
 */
export function providerRequestIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
