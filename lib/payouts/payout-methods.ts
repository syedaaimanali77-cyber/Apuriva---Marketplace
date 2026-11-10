/**
 * Spec 024 §3.9 "Payout-method security" (AC-4, AC-10, AC-11).
 *
 * The platform stores NO credential. A client sends only the rail's single-use `setupToken`; the
 * server exchanges it via `registerDestination()` and stores only what the RAIL returned — a
 * `masked_detail` and `institution_label` are never taken from the request body.
 *
 * Step-up is enforced by the route guard (`app/api/v1/payouts/route-guards.ts`) before any function
 * here runs. Every mutation serializes on the provider's method rows (`FOR UPDATE`, ascending id),
 * and `payout_methods_default_uq` is the structural guarantee of one default per currency.
 * Rail calls happen outside transactions.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { validationError } from '@/lib/api/errors';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import { resolvePayoutProvider } from '@/lib/payments/provider/payout-factory';
import type { PayoutMethodDto } from '@/lib/types/payouts';
import { decryptDestinationToken, encryptDestinationToken } from './destination-crypto';
import {
  idempotencyKeyConflictError,
  payoutConflictError,
  payoutMethodInUseError,
  payoutMethodNotFoundError,
  payoutMethodNotVerifiedError,
  payoutMethodSetupInvalidError,
} from './errors';
import { scopeFilter, type PayoutSweepScope } from './sweep-scope';

const MAX_SETUP_TOKEN_LENGTH = 512;
/** I-15 — more than four digits anywhere in a mask means it could be an account number. */
const TOO_MANY_DIGITS = /[0-9](?:[^0-9]*[0-9]){4}/;

interface MethodRow {
  id: string;
  type: 'bank' | 'mobile_wallet';
  masked_detail: string;
  institution_label: string;
  payout_currency_code: string;
  verification_state: 'pending' | 'verified' | 'rejected';
  is_default: boolean;
  removed_at: Date | null;
  created_at: Date;
  version: number;
  idempotency_fingerprint?: string;
}

const METHOD_COLUMNS = sql`id, type, masked_detail, institution_label, payout_currency_code, verification_state,
  is_default, removed_at, created_at, version`;

export function toPayoutMethodDto(row: MethodRow): PayoutMethodDto {
  return {
    id: row.id,
    type: row.type,
    maskedDetail: row.masked_detail,
    institutionLabel: row.institution_label,
    payoutCurrencyCode: row.payout_currency_code,
    verificationState: row.verification_state,
    isDefault: row.is_default,
    removedAt: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

export async function listPayoutMethods(providerProfileId: string): Promise<PayoutMethodDto[]> {
  const rows = await queryRows<MethodRow>(
    getDb(),
    sql`SELECT ${METHOD_COLUMNS} FROM payout_methods WHERE provider_profile_id = ${providerProfileId}
         ORDER BY (removed_at IS NOT NULL) ASC, created_at DESC`,
  );
  return rows.map(toPayoutMethodDto);
}

async function lockProviderMethods(tx: Executor, providerProfileId: string): Promise<void> {
  await tx.execute(sql`SELECT id FROM payout_methods WHERE provider_profile_id = ${providerProfileId} ORDER BY id FOR UPDATE`);
}

async function findByKey(providerProfileId: string, idempotencyKey: string): Promise<MethodRow | undefined> {
  const [row] = await queryRows<MethodRow>(
    getDb(),
    sql`SELECT ${METHOD_COLUMNS}, idempotency_fingerprint FROM payout_methods
         WHERE provider_profile_id = ${providerProfileId} AND idempotency_key = ${idempotencyKey}`,
  );
  return row;
}

function replayOrConflict(row: MethodRow, fingerprint: string): { method: PayoutMethodDto; replayed: true } {
  if (row.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
  return { method: toPayoutMethodDto(row), replayed: true };
}

async function audit(userId: string, eventType: string, method: PayoutMethodDto, correlationId: string): Promise<void> {
  // AC-10: the security record carries the mask only — never the setup or destination token.
  await recordSecurityEvent({
    userId,
    eventType,
    severity: 'warning',
    metadata: { payoutMethodId: method.id, type: method.type, maskedDetail: method.maskedDetail, correlationId },
  });
  console.log(JSON.stringify({ event: 'payout_method.changed', change: eventType, payoutMethodId: method.id, correlationId }));
}

export async function createPayoutMethod(input: {
  userId: string;
  providerProfileId: string;
  idempotencyKey: string;
  body: unknown;
  correlationId: string;
}): Promise<{ method: PayoutMethodDto; replayed: boolean }> {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const setupToken = typeof body.setupToken === 'string' ? body.setupToken.trim() : '';
  if (setupToken.length === 0) throw validationError([{ field: 'setupToken', message: 'is required' }]);
  if (setupToken.length > MAX_SETUP_TOKEN_LENGTH) {
    throw validationError([{ field: 'setupToken', message: `must be at most ${MAX_SETUP_TOKEN_LENGTH} characters` }]);
  }
  // The fingerprint is a SHA-256 over the canonical body — the token itself is never stored.
  const fingerprint = idempotencyFingerprint({ setupToken });

  const existing = await findByKey(input.providerProfileId, input.idempotencyKey);
  if (existing) return replayOrConflict(existing, fingerprint);

  const provider = resolvePayoutProvider();
  const destination = await provider.registerDestination(setupToken);
  if (!destination) {
    const raced = await findByKey(input.providerProfileId, input.idempotencyKey);
    if (raced) return replayOrConflict(raced, fingerprint);
    throw payoutMethodSetupInvalidError();
  }
  if (TOO_MANY_DIGITS.test(destination.maskedDetail) || !/^[A-Z]{3}$/.test(destination.payoutCurrencyCode)) {
    throw payoutMethodSetupInvalidError();
  }

  const encrypted = encryptDestinationToken(destination.destinationToken);

  const insert = async (asDefault: boolean) =>
    getDb().transaction(async (tx) => {
      await lockProviderMethods(tx, input.providerProfileId);
      const [liveDefault] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM payout_methods WHERE provider_profile_id = ${input.providerProfileId}
               AND payout_currency_code = ${destination.payoutCurrencyCode} AND is_default AND removed_at IS NULL`,
      );
      const [row] = await queryRows<MethodRow>(
        tx,
        sql`INSERT INTO payout_methods (
              provider_profile_id, type, masked_detail, institution_label, payout_currency_code,
              destination_token_encrypted, provider_name, verification_state, is_default,
              idempotency_key, idempotency_fingerprint
            ) VALUES (
              ${input.providerProfileId}, ${destination.type}, ${destination.maskedDetail}, ${destination.institutionLabel},
              ${destination.payoutCurrencyCode}, ${encrypted}, ${provider.name}, 'verified', ${asDefault && !liveDefault},
              ${input.idempotencyKey}, ${fingerprint}
            ) RETURNING ${METHOD_COLUMNS}`,
      );
      return toPayoutMethodDto(row!);
    });

  let method: PayoutMethodDto;
  try {
    method = await insert(true);
  } catch (err) {
    if (isUniqueViolation(err, 'payout_methods_idempotency_uq')) {
      const winner = await findByKey(input.providerProfileId, input.idempotencyKey);
      if (winner) return replayOrConflict(winner, fingerprint);
    }
    if (!isUniqueViolation(err, 'payout_methods_default_uq')) throw err;
    method = await insert(false);
  }

  await audit(input.userId, 'payout_method.created', method, input.correlationId);
  return { method, replayed: false };
}

export async function setDefaultPayoutMethod(input: {
  userId: string;
  providerProfileId: string;
  methodId: string;
  body: unknown;
  correlationId: string;
}): Promise<PayoutMethodDto> {
  const body = (input.body ?? {}) as Record<string, unknown>;
  if (body.isDefault !== true) throw validationError([{ field: 'isDefault', message: 'must be true' }]);

  const attempt = () =>
    getDb().transaction(async (tx): Promise<{ method: PayoutMethodDto; changed: boolean }> => {
      await lockProviderMethods(tx, input.providerProfileId);
      const [target] = await queryRows<MethodRow>(
        tx,
        sql`SELECT ${METHOD_COLUMNS} FROM payout_methods WHERE id = ${input.methodId} AND provider_profile_id = ${input.providerProfileId}`,
      );
      if (!target || target.removed_at) throw payoutMethodNotFoundError();
      if (target.verification_state !== 'verified') throw payoutMethodNotVerifiedError();
      if (target.is_default) return { method: toPayoutMethodDto(target), changed: false };

      await tx.execute(sql`
        UPDATE payout_methods SET is_default = false, updated_at = clock_timestamp(), version = version + 1
         WHERE provider_profile_id = ${input.providerProfileId} AND payout_currency_code = ${target.payout_currency_code}
           AND is_default AND removed_at IS NULL AND id <> ${input.methodId}
      `);
      const [row] = await queryRows<MethodRow>(
        tx,
        sql`UPDATE payout_methods SET is_default = true, updated_at = clock_timestamp(), version = version + 1
             WHERE id = ${input.methodId} RETURNING ${METHOD_COLUMNS}`,
      );
      return { method: toPayoutMethodDto(row!), changed: true };
    });

  let result: { method: PayoutMethodDto; changed: boolean };
  try {
    result = await attempt();
  } catch (err) {
    if (!isUniqueViolation(err, 'payout_methods_default_uq')) throw err;
    try {
      result = await attempt();
    } catch (retryErr) {
      if (isUniqueViolation(retryErr, 'payout_methods_default_uq')) throw payoutConflictError();
      throw retryErr;
    }
  }

  if (result.changed) await audit(input.userId, 'payout_method.default_changed', result.method, input.correlationId);
  return result.method;
}

export async function removePayoutMethod(input: {
  userId: string;
  providerProfileId: string;
  methodId: string;
  correlationId: string;
}): Promise<PayoutMethodDto> {
  const result = await getDb().transaction(async (tx): Promise<{ method: PayoutMethodDto; removedNow: boolean }> => {
    await lockProviderMethods(tx, input.providerProfileId);
    const [target] = await queryRows<MethodRow>(
      tx,
      sql`SELECT ${METHOD_COLUMNS} FROM payout_methods WHERE id = ${input.methodId} AND provider_profile_id = ${input.providerProfileId}`,
    );
    if (!target) throw payoutMethodNotFoundError();
    if (target.removed_at) return { method: toPayoutMethodDto(target), removedNow: false };

    // A method snapshotted on a payout that is ready or in progress is still in use (§3.9).
    const [snapshotted] = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM payouts WHERE payout_method_id = ${input.methodId} AND status IN ('eligible','processing') LIMIT 1`,
    );
    if (snapshotted) throw payoutMethodInUseError();

    const [{ live, in_flight: inFlight }] = (await queryRows<{ live: number; in_flight: number }>(
      tx,
      sql`SELECT
            (SELECT COUNT(*)::int FROM payout_methods WHERE provider_profile_id = ${input.providerProfileId} AND removed_at IS NULL) AS live,
            (SELECT COUNT(*)::int FROM payouts WHERE provider_profile_id = ${input.providerProfileId} AND status IN ('eligible','processing')) AS in_flight`,
    )) as [{ live: number; in_flight: number }];
    if (live <= 1 && inFlight > 0) throw payoutMethodInUseError();

    const [row] = await queryRows<MethodRow>(
      tx,
      sql`UPDATE payout_methods SET removed_at = clock_timestamp(), is_default = false,
                 updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${input.methodId} RETURNING ${METHOD_COLUMNS}`,
    );
    return { method: toPayoutMethodDto(row!), removedNow: true };
  });

  if (result.removedNow) {
    await revokeRemovedMethod(input.methodId);
    await audit(input.userId, 'payout_method.removed', result.method, input.correlationId);
  }
  return result.method;
}

/**
 * Revokes one removed-but-unrevoked destination at the rail, AFTER the soft delete committed. A rail
 * outage never blocks removal: the payout sweep retries every removed, unrevoked method.
 */
export async function revokeRemovedMethod(methodId: string): Promise<boolean> {
  const [row] = await queryRows<{ destination_token_encrypted: string; removed_at: Date | null; revoked_at: Date | null }>(
    getDb(),
    sql`SELECT destination_token_encrypted, removed_at, revoked_at FROM payout_methods WHERE id = ${methodId}`,
  );
  if (!row || !row.removed_at || row.revoked_at) return false;

  try {
    await resolvePayoutProvider().revokeDestination(decryptDestinationToken(row.destination_token_encrypted));
  } catch (err) {
    console.error(JSON.stringify({ event: 'payout_method.revocation_failed', payoutMethodId: methodId, error: err instanceof Error ? err.name : 'error' }));
    return false;
  }
  await getDb().execute(sql`
    UPDATE payout_methods SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${methodId} AND revoked_at IS NULL
  `);
  return true;
}

export async function revokePendingRemovedMethods(scope?: PayoutSweepScope): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM payout_methods WHERE removed_at IS NOT NULL AND revoked_at IS NULL ${scopeFilter(sql`provider_profile_id`, scope)} ORDER BY removed_at LIMIT 200`,
  );
  let revoked = 0;
  for (const row of rows) if (await revokeRemovedMethod(row.id)) revoked += 1;
  return revoked;
}
