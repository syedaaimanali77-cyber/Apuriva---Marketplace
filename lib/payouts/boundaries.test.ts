import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 024 §6 "Source guard" — the boundaries this spec must never cross, asserted on CODE (comments
 * stripped first, exactly as spec 021's guard does, so a file documenting its own boundary passes).
 */
const ROOT = join(__dirname, '..', '..');
const PAYOUTS_DIR = join(ROOT, 'lib', 'payouts');
const PROVIDER_DIR = join(ROOT, 'lib', 'payments', 'provider');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const isProduction = (file: string) => !/\.test\.tsx?$/.test(file) && !/test-support\.ts$/.test(file);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PAYOUT_FILES = sourceFiles(PAYOUTS_DIR).filter(isProduction);

/** The source text inside each `.transaction( ... )` call, found by matching parentheses. */
function transactionScopes(source: string): string[] {
  const scopes: string[] = [];
  let index = source.indexOf('.transaction(');
  while (index !== -1) {
    let depth = 0;
    let end = index + '.transaction'.length;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    scopes.push(source.slice(index, end + 1));
    index = source.indexOf('.transaction(', end);
  }
  return scopes;
}
const PAYOUT_ADAPTER_FILES = ['payout-types.ts', 'sandbox-payout.ts', 'payout-factory.ts'].map((f) => join(PROVIDER_DIR, f));

describe('spec 024 — payout boundaries', () => {
  it('has production sources to check', () => {
    expect(PAYOUT_FILES.length).toBeGreaterThan(10);
  });

  it('reads no payout credential and imports no rail SDK outside lib/payments/provider, in lib/ or app/', () => {
    const offenders = [...sourceFiles(join(ROOT, 'lib')), ...sourceFiles(join(ROOT, 'app'))]
      .filter(isProduction)
      .filter((file) => !file.startsWith(PROVIDER_DIR))
      .filter((file) => /process\.env\.PAYOUT_[A-Z0-9_]*(KEY|SECRET|TOKEN|CREDENTIAL)/.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('the payout adapter files are pure rail clients: they touch no table', () => {
    for (const file of PAYOUT_ADAPTER_FILES) {
      const source = code(file);
      expect(source).not.toMatch(/@\/lib\/db|drizzle-orm|INSERT INTO|UPDATE\s+"?\w+"?\s+SET|payout_methods|payoutMethods/);
    }
  });

  it('writes payouts.status only through the state machine', () => {
    const offenders = PAYOUT_FILES.filter((file) => !file.endsWith('state-machine.ts')).filter((file) =>
      /UPDATE\s+payouts\s+SET(?:(?!WHERE)[^`])*[\s,]status\s*=/i.test(code(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('never refunds, never rewrites refunds beyond reconciliation, never reads price_adjustments, and writes no payment/booking row', () => {
    for (const file of PAYOUT_FILES) {
      const source = code(file);
      expect(source, file).not.toMatch(/\.refund\(|getRefundStatus/);
      expect(source, file).not.toMatch(/INSERT INTO\s+"?refunds/i);
      expect(source, file).not.toMatch(/price_adjustments|priceAdjustments/);
      expect(source, file).not.toMatch(/(INSERT INTO|UPDATE)\s+"?(payments|payment_authorizations|bookings)\b/i);
      for (const update of source.match(/UPDATE\s+refunds\s+SET[\s\S]*?WHERE/gi) ?? []) {
        const columns = [...update.matchAll(/(\w+)\s*=/g)].map((m) => m[1]);
        expect(new Set(columns), file).toEqual(new Set(['reconciliation_state', 'reconciled_at', 'updated_at', 'version']));
      }
    }
  });

  it('contains no cancellation-policy or fee-tier literal', () => {
    for (const file of PAYOUT_FILES) {
      expect(code(file), file).not.toMatch(/cancellation_tier|tierFeePercent|tier_fee_percent|lib\/cancellation/);
    }
  });

  it('no DTO or export type exposes a rail handle, token or idempotency data', () => {
    const types = code(join(ROOT, 'lib', 'types', 'payouts.ts'));
    expect(types).not.toMatch(/payoutReference|destinationToken|idempotencyKey|providerName|failureReason\??:\s*string[^;]*;\s*\n\s*}\s*\n\s*export interface PayoutDto/);
    expect(types).not.toMatch(/interface PayoutDto[^}]*(payoutReference|destinationToken|failureReason|attemptCount)/);
    expect(types).not.toMatch(/interface EarningsLineDto[^}]*(payoutReference|destinationToken|idempotency)/);
    const privacy = code(join(PAYOUTS_DIR, 'privacy.ts'));
    expect(privacy).not.toMatch(/destination_token_encrypted|payout_reference|provider_name|failure_reason|idempotency_|admin_action_id|source_refund_id/);
  });

  it('never makes a rail call inside a transaction', () => {
    for (const file of PAYOUT_FILES) {
      for (const scope of transactionScopes(code(file))) {
        expect(scope, file).not.toMatch(/\.(transfer|registerDestination|revokeDestination|getPayoutStatus|getPayoutStatusByIdempotencyKey)\(/);
      }
    }
  });

  it('security-event metadata never carries a token', () => {
    const source = code(join(PAYOUTS_DIR, 'payout-methods.ts'));
    const metadata = source.slice(source.indexOf('recordSecurityEvent('), source.indexOf('});', source.indexOf('recordSecurityEvent(')));
    expect(metadata).not.toMatch(/token/i);
  });
});
