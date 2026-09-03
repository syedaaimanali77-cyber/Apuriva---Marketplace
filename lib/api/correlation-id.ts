/**
 * Correlation ID convention — spec 004 AC-1/AC-2, §9 Observability. Every `/api/v1/*` response
 * carries one so request logs can be tied end-to-end to the response the caller saw. A caller
 * (or an upstream proxy/gateway) may already have minted one for the request; when present it is
 * reused so a single logical request keeps one ID across service boundaries, otherwise a new one
 * is generated here.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

// Conservative shape check on a caller-supplied ID: bounded length, no characters that could
// break a downstream log line or header. Anything else falls back to a freshly generated ID
// rather than propagating untrusted, unbounded input into logs/headers.
const VALID_CORRELATION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function getOrCreateCorrelationId(request: Request): string {
  const provided = request.headers.get(CORRELATION_ID_HEADER);
  if (provided && VALID_CORRELATION_ID.test(provided)) return provided;
  return crypto.randomUUID();
}
