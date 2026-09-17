/**
 * Spec 026 — raw-SQL helpers local to `lib/notifications`. Deliberately NOT imported from another
 * domain (e.g. `lib/offers/db`): `boundaries.test.ts` keeps this module free of producing-spec imports.
 */
import type { SQL } from 'drizzle-orm';
import type { getDb } from '@/lib/db';

/** A database handle or a transaction on it — both expose `execute`. */
export type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

export async function queryRows<T>(db: Executor, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

export function isUniqueViolation(err: unknown, constraint: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code === '23505' && candidate.constraint === constraint;
    current = candidate.cause;
  }
  return false;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
