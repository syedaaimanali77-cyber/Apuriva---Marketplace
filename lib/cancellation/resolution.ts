/**
 * Spec 023 §3 "Precedence" and "Acceptance and snapshotting" (AC-1, AC-4).
 *
 * Resolution answers one question — "which tier ladder governs this service at this instant?" — and
 * answers it deterministically:
 *
 *     service override  →  category override  →  platform default
 *
 * A scope contributes only if it is ACTIVE and has exactly one version whose
 * `[effective_from, effective_to)` contains the instant. Every other case falls through rather than
 * guessing, and if even the platform default is unusable the caller gets
 * `422 CANCELLATION_POLICY_UNAVAILABLE` — never a default-allow, never an invented tier.
 *
 * "Multiple active versions cover the same instant" is impossible by construction:
 * `policy_versions_no_overlap_ex` (a GiST exclusion constraint) rejects the overlapping insert. The
 * `LIMIT 2` read below is the belt to that braces — if a manual write ever produced two, resolution
 * refuses rather than silently picking one.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, isUniqueViolation, type Executor } from '@/lib/offers/db';
import type {
  CancellationPolicyConfig,
  CancellationPolicyDto,
  CancellationTier,
  PolicySource,
} from '@/lib/types/cancellation';
import { cancellationPolicyUnavailableError } from './errors';
import { parseCancellationPolicyConfig } from './policy-config';

export interface ResolvedPolicy {
  policyVersionId: string;
  source: PolicySource;
  providerOptionKey: string | null;
  tiers: CancellationTier[];
  config: CancellationPolicyConfig;
}

interface CandidateRow {
  version_id: string;
  config: unknown;
  scope: 'platform' | 'category' | 'service';
}

/**
 * The candidate versions for a service, one per scope, all read in a single statement.
 *
 * `ORDER BY` encodes the precedence itself (service 1, category 2, platform 3), so the caller takes
 * the first usable row rather than re-deciding priority in application code.
 */
async function candidatesForService(tx: Executor, serviceId: string, asOf: Date): Promise<CandidateRow[]> {
  return queryRows<CandidateRow>(
    tx,
    sql`SELECT pv.id AS version_id, pv.config, p.scope
          FROM services s
          JOIN policies p
            ON p.type = 'cancellation'
           AND p.is_active
           AND (
                 (p.scope = 'service'  AND p.scope_id = s.id)
              OR (p.scope = 'category' AND p.scope_id = s.category_id)
              OR (p.scope = 'platform')
               )
          JOIN policy_versions pv
            ON pv.policy_id = p.id
           AND pv.effective_from <= ${asOf}
           AND (pv.effective_to IS NULL OR pv.effective_to > ${asOf})
         WHERE s.id = ${serviceId}
         ORDER BY CASE p.scope WHEN 'service' THEN 1 WHEN 'category' THEN 2 ELSE 3 END,
                  pv.effective_from DESC`,
  );
}

const SOURCE_BY_SCOPE: Record<CandidateRow['scope'], PolicySource> = {
  service: 'service_override',
  category: 'category_override',
  platform: 'platform_default',
};

/**
 * Applies a provider's selected option, if the EFFECTIVE version publishes that key.
 *
 * A stale or unknown key is treated as absent on this read path (the version's own tiers apply)
 * rather than failing a customer's cancellation because a provider's selection went out of date.
 * The write path is where an unknown key is rejected, with `422 POLICY_OPTION_NOT_ALLOWED` — so a
 * provider can never invent a fee, and can never break an existing booking either (AC-4).
 */
function applyProviderOption(
  config: CancellationPolicyConfig,
  optionKey: string | null,
): { tiers: CancellationTier[]; providerOptionKey: string | null } {
  if (!optionKey) return { tiers: config.tiers, providerOptionKey: null };
  const option = config.allowedOptions.find((candidate) => candidate.key === optionKey);
  if (!option) return { tiers: config.tiers, providerOptionKey: null };
  return { tiers: option.tiers, providerOptionKey: option.key };
}

export interface ResolveOptions {
  /** The provider's selected option key, when resolving for a booking with a known provider. */
  providerOptionKey?: string | null;
}

/**
 * Resolves the effective policy for a service at an instant. Throws
 * `422 CANCELLATION_POLICY_UNAVAILABLE` when nothing usable resolves.
 */
export async function resolveEffectivePolicy(
  tx: Executor,
  serviceId: string,
  asOf: Date,
  options: ResolveOptions = {},
): Promise<ResolvedPolicy> {
  const rows = await candidatesForService(tx, serviceId, asOf);

  const byScope = new Map<CandidateRow['scope'], CandidateRow[]>();
  for (const row of rows) {
    const bucket = byScope.get(row.scope) ?? [];
    bucket.push(row);
    byScope.set(row.scope, bucket);
  }

  for (const scope of ['service', 'category', 'platform'] as const) {
    const candidates = byScope.get(scope);
    if (!candidates || candidates.length === 0) continue;
    if (candidates.length > 1) {
      // Only reachable if the exclusion constraint was bypassed by a manual write. Refuse rather
      // than silently pick: an ambiguous policy must never price a real cancellation.
      console.error(
        JSON.stringify({ event: 'cancellation.policy_ambiguous', serviceId, scope, versionCount: candidates.length }),
      );
      throw cancellationPolicyUnavailableError('ambiguous_policy_versions');
    }

    const candidate = candidates[0]!;
    const config = parseCancellationPolicyConfig(candidate.config);
    if (!config) {
      // A stored configuration that fails the grammar is treated as ABSENT — fall through to the
      // next scope — and logged, so an operator sees it. Never trusted, never repaired in place.
      console.error(
        JSON.stringify({ event: 'cancellation.policy_config_invalid', serviceId, scope, versionId: candidate.version_id }),
      );
      continue;
    }

    const { tiers, providerOptionKey } = applyProviderOption(config, options.providerOptionKey ?? null);
    return { policyVersionId: candidate.version_id, source: SOURCE_BY_SCOPE[scope], providerOptionKey, tiers, config };
  }

  throw cancellationPolicyUnavailableError();
}

/** `GET /services/{id}/cancellation-policy` — the effective policy as of now. */
export async function readServiceCancellationPolicy(serviceId: string): Promise<CancellationPolicyDto> {
  const db = getDb();
  const [service] = await queryRows<{ id: string }>(db, sql`SELECT id FROM services WHERE id = ${serviceId}`);
  if (!service) throw cancellationPolicyUnavailableError('unknown_service');

  const resolved = await resolveEffectivePolicy(db, serviceId, new Date());
  return {
    policyVersionId: resolved.policyVersionId,
    source: resolved.source,
    providerOptionKey: resolved.providerOptionKey,
    tiers: resolved.tiers,
  };
}

export interface BookingPolicyContext {
  bookingId: string;
  serviceId: string;
  customerUserId: string;
  bookingCreatedAt: Date;
  providerOptionKey: string | null;
}

/**
 * The booking's SNAPSHOT — AC-1's guarantee that a later configuration change can never alter an
 * existing customer's terms.
 *
 * Spec 020 owns booking creation and is shipped, so the row is materialised LAZILY — but it is
 * resolved **as of `bookings.created_at`**, never as of now. Because versions are immutable and
 * their intervals append-only, that is exactly what an eager write at booking time would have
 * produced: a materialisation, not a re-decision.
 *
 * Concurrent materialisation is settled by `policy_acceptances_booking_uq`: the loser catches the
 * unique violation and re-reads the winner's row, so two callers can never disagree about a
 * booking's terms.
 */
export async function ensurePolicyAcceptance(tx: Executor, context: BookingPolicyContext): Promise<ResolvedPolicy> {
  const existing = await readAcceptance(tx, context.bookingId);
  if (existing) return existing;

  const resolved = await resolveEffectivePolicy(tx, context.serviceId, context.bookingCreatedAt, {
    providerOptionKey: context.providerOptionKey,
  });

  try {
    await tx.execute(sql`
      INSERT INTO policy_acceptances
        (policy_version_id, user_id, booking_id, accepted_config, provider_option_key, source, booking_created_at)
      VALUES (${resolved.policyVersionId}, ${context.customerUserId}, ${context.bookingId},
              ${JSON.stringify({ tiers: resolved.tiers })}::jsonb, ${resolved.providerOptionKey},
              ${resolved.source}, ${context.bookingCreatedAt})
    `);
  } catch (err) {
    if (!isUniqueViolation(err, 'policy_acceptances_booking_uq')) throw err;
    const winner = await readAcceptance(tx, context.bookingId);
    if (!winner) throw err;
    return winner;
  }

  return resolved;
}

/** The stored snapshot, or `null` when this booking has not needed one yet. */
export async function readAcceptance(tx: Executor, bookingId: string): Promise<ResolvedPolicy | null> {
  const [row] = await queryRows<{
    policy_version_id: string;
    accepted_config: unknown;
    provider_option_key: string | null;
    source: PolicySource;
  }>(
    tx,
    sql`SELECT policy_version_id, accepted_config, provider_option_key, source
          FROM policy_acceptances WHERE booking_id = ${bookingId}`,
  );
  if (!row) return null;

  const accepted = row.accepted_config as { tiers?: unknown } | null;
  const config = parseCancellationPolicyConfig({ tiers: accepted?.tiers, allowedOptions: [] });
  if (!config) throw cancellationPolicyUnavailableError('snapshot_config_invalid');

  return {
    policyVersionId: row.policy_version_id,
    source: row.source,
    providerOptionKey: row.provider_option_key,
    tiers: config.tiers,
    config,
  };
}
