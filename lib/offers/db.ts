/**
 * Spec 018 — shared raw-SQL helpers for `lib/offers/*`.
 *
 * The offer paths need three things Drizzle's query builder cannot express cleanly: row locks taken in
 * a fixed order, reads of `clock_timestamp()` (the database clock — never `now()`, which is frozen at
 * transaction start, and never the app server's clock), and single-statement updates that read the
 * clock once. So they run parameterized `sql` through the same connection/transaction Drizzle uses.
 */
import type { SQL } from 'drizzle-orm';
import type { getDb } from '@/lib/db';

/** A database handle or a transaction on it — both expose `execute`. */
export type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

export async function queryRows<T>(db: Executor, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

/** The PostgreSQL error behind a (possibly Drizzle-wrapped) driver error, if any. */
export function pgError(err: unknown): { code?: string; constraint?: string } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined };
    }
    current = candidate.cause;
  }
  return null;
}

export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgError(err);
  return pg?.code === '23505' && pg.constraint === constraint;
}
