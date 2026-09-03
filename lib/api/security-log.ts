/**
 * AC-4: a rejected-for-permission attempt must be logged, correlated by the same ID the caller
 * received. Spec 004 §4 is explicit this spec persists nothing itself (no DB write here) —
 * structured stdout is picked up by the platform's log pipeline per
 * docs/specs/2026-08-28-046-engineering-operations-cicd-observability.md. A later spec (e.g.
 * 039 audit logging) may additionally persist security-relevant attempts to `audit_logs`.
 */
export function logForbiddenAttempt(params: { correlationId: string; path: string; method: string; reason: string }): void {
  console.warn(
    JSON.stringify({
      event: 'api.forbidden',
      correlationId: params.correlationId,
      method: params.method,
      path: params.path,
      reason: params.reason,
      at: new Date().toISOString(),
    }),
  );
}
