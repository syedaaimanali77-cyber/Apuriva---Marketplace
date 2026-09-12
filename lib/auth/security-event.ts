import { getDb } from '@/lib/db';
import { securityEvents } from '@/lib/db/schema';

export type SecurityEventSeverity = 'info' | 'warning' | 'critical';

export interface RecordSecurityEventInput {
  userId?: string | null;
  eventType: string;
  severity: SecurityEventSeverity;
  metadata?: Record<string, unknown>;
}

/**
 * Persists a `SecurityEvent` row (spec 005 §4). Distinct from `lib/api/security-log.ts` (spec
 * 004's stdout-only log for a generic 403) — this is the durable record spec 005 AC-2/AC-5 and
 * §9 Observability require for actual authentication/security incidents.
 */
export async function recordSecurityEvent(input: RecordSecurityEventInput): Promise<void> {
  await getDb()
    .insert(securityEvents)
    .values({
      userId: input.userId ?? null,
      eventType: input.eventType,
      severity: input.severity,
      metadata: input.metadata ?? null,
    });
}
