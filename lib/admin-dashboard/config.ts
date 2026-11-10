/**
 * Spec 037 §3 "Marketplace configuration" (AC-3) — a READ-ONLY overview of the business
 * configuration, never a replacement for the editors that own it (D-3).
 *
 * One authoritative write path per setting stays with its owner and is neither re-implemented nor
 * forwarded here: spec 017's `PATCH /admin/services/{id}/matching-weights` and suggestion approval,
 * and spec 023's `POST /admin/cancellation-policies`. This module imports only their PERMISSION
 * CONSTANTS and spec 017's default-weights constant — never a write function
 * (`lib/admin-dashboard/boundary.test.ts` asserts it).
 */
import { sql } from 'drizzle-orm';
import { forbiddenError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { CANCELLATION_POLICY_READ_ACTION, CANCELLATION_POLICY_RESOURCE } from '@/lib/cancellation/admin';
import { MATCHING_RESOURCE } from '@/lib/matching/admin';
import { DEFAULT_MATCHING_WEIGHTS } from '@/lib/matching/weights';
import { queryRows, type Executor } from '@/lib/offers/db';
import type {
  MarketplaceCancellationConfigDto,
  MarketplaceConfigDto,
  MarketplaceMatchingConfigDto,
} from '@/lib/types/admin-dashboard';
import { holdsPermission } from './access';

/** Spec 017's read action on `matching.config` (seeded in drizzle/0013, operations/super admin). */
export const MATCHING_READ_ACTION = 'read';

export async function readMatchingSection(db: Executor): Promise<MarketplaceMatchingConfigDto> {
  const [row] = await queryRows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM services WHERE matching_weights IS NOT NULL`,
  );
  return {
    // A copy, field by field from the constant — never a reference a caller could mutate.
    platformDefaultWeights: { ...DEFAULT_MATCHING_WEIGHTS },
    serviceOverrideCount: row?.n ?? 0,
    linkTo: '/admin/marketplace/matching',
  };
}

/** The open version of the active platform-scope cancellation policy (spec 023), if any. */
export async function readCancellationSection(db: Executor): Promise<MarketplaceCancellationConfigDto> {
  const [row] = await queryRows<{ policy_id: string; effective_from: Date | string; config: unknown }>(
    db,
    sql`SELECT p.id AS policy_id, v.effective_from, v.config
          FROM policies p
          JOIN policy_versions v ON v.policy_id = p.id AND v.effective_to IS NULL
         WHERE p.type = 'cancellation' AND p.scope = 'platform' AND p.scope_id IS NULL AND p.is_active
         LIMIT 1`,
  );
  return {
    activePlatformPolicy: row
      ? { policyId: row.policy_id, effectiveFrom: new Date(row.effective_from).toISOString(), config: row.config }
      : null,
    // Spec 023 assigns the configuration UI to spec 041 (Draft): there is no editor page to link.
    linkTo: null,
  };
}

/**
 * `GET /api/v1/admin/marketplace/config` (AC-3, AC-6). Each section appears only for a caller
 * holding its existing read permission; a caller holding neither — every role except
 * operations_admin and super_admin today — receives `403 FORBIDDEN`.
 */
export async function getMarketplaceConfig(
  userId: string,
  options: { db?: Executor; now?: Date } = {},
): Promise<MarketplaceConfigDto> {
  const [canReadMatching, canReadCancellation] = await Promise.all([
    holdsPermission(userId, MATCHING_RESOURCE, MATCHING_READ_ACTION),
    holdsPermission(userId, CANCELLATION_POLICY_RESOURCE, CANCELLATION_POLICY_READ_ACTION),
  ]);
  if (!canReadMatching && !canReadCancellation) {
    throw forbiddenError('You do not have permission to view the marketplace configuration.');
  }

  const db = options.db ?? getDb();
  const dto: MarketplaceConfigDto = { generatedAt: (options.now ?? new Date()).toISOString() };
  if (canReadMatching) dto.matching = await readMatchingSection(db);
  if (canReadCancellation) dto.cancellation = await readCancellationSection(db);
  return dto;
}
