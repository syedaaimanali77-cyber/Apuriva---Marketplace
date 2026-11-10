/**
 * Spec 018 §3 — `withApiRoute` forwards only `(request, correlationId)`, never Next's route `context`,
 * so a `{id}` route reads its own parameter from the URL (the same pattern as
 * `app/api/v1/requests/request-id.ts`). `depthFromEnd` is `0` for `/offers/{id}` and `1` for
 * `/offers/{id}/accept|decline|withdraw`.
 */
export function offerIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
