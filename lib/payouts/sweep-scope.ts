/**
 * Spec 024 §3.6 — the optional provider scope every sweep pass accepts. Kept in its own module so the
 * sweep, transfer and payout-method modules can share it without importing each other.
 */
import { sql, type SQL } from 'drizzle-orm';

export interface PayoutSweepScope {
  /**
   * Restricts every pass to these providers. The cron route passes none (the whole platform); a scope
   * is for a targeted operational replay of specific providers, and lets suites sharing one database
   * drive their own rows without acting on another suite's.
   */
  providerProfileIds?: readonly string[];
}

export function scopeFilter(column: SQL, scope?: PayoutSweepScope): SQL {
  const ids = scope?.providerProfileIds;
  if (!ids) return sql``;
  if (ids.length === 0) return sql` AND false`;
  return sql` AND ${column} IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
}
