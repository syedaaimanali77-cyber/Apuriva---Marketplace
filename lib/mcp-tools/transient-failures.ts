/**
 * Spec 036 §3 "Retry policy" — the classification of TRANSIENT INFRASTRUCTURE failures.
 *
 * Neither the repository nor any spec establishes one: no module classifies database, connection or
 * network failures as transient. So the classified set is EMPTY and nothing is retried
 * automatically. This spec does not invent one; adding a member is a spec change.
 */
export function isTransientInfrastructureFailure(_err: unknown): boolean {
  return false;
}
