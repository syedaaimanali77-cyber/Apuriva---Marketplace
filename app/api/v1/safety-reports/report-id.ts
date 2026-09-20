/**
 * Spec 030 — the safety report id from the URL path.
 *
 * Read from the path rather than from a Next.js `params` promise for the same reason spec 029's
 * `reviewIdFromUrl` does: these handlers are driven directly in integration tests with a plain
 * `Request`, and a helper that works identically in both places keeps the routes thin.
 */
export function safetyReportIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
