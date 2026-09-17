/**
 * Spec 025 §3 — `withApiRoute` forwards only `(request, correlationId)`, never Next's route `context`, so
 * a `{id}` route reads its own parameter from the URL: the pattern `app/api/v1/bookings/booking-id.ts`
 * established. `depthFromEnd` is `0` for `/admin/conversations/{id}` and `1` for `.../{id}/messages`.
 */
export function conversationIdFromUrl(request: Request, depthFromEnd: number): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
