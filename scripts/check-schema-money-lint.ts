/**
 * CI/architecture check for spec 003 AC-1: "any monetary value in the schema ... is stored as
 * its own semantically-named integer (minor units) column ... never numeric, float, or double."
 *
 * Two checks, run independently of the vitest suite so this can gate CI without spinning up a
 * test runner:
 *   1. Money-suffixed columns (name matches a monetary-sounding suffix, e.g. `*_amount`,
 *      `*_amount_minor_units`, `*_price`, `*_fee`, `*_cost`, `*_balance`, `*_total`) must never
 *      be numeric/real/double-precision.
 *   2. Defense-in-depth, matching AC-1's absolute wording: no numeric/real/double-precision
 *      column may exist anywhere in the baseline schema, money-suffixed or not — a table can't
 *      regress into float money by picking a name the suffix list doesn't happen to catch.
 *
 * Usage: npm run check:schema-money-lint
 */
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../lib/db/schema';

const FLOAT_MONEY_TYPES = new Set(['PgNumeric', 'PgNumericNumber', 'PgNumericBigInt', 'PgReal', 'PgDoublePrecision']);
const MONEY_SUFFIX_PATTERN = /(_amount(_minor_units)?|_minor_units|_price|_fee|_cost|_balance|_total)$/i;

function allTables(): PgTable[] {
  return Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[];
}

function fail(offenders: string[], header: string): void {
  console.error(`check:schema-money-lint FAILED — ${header}`);
  for (const offender of offenders) console.error(`  - ${offender}`);
}

let failed = false;

const moneySuffixOffenders: string[] = [];
const anyFloatOffenders: string[] = [];

for (const table of allTables()) {
  const config = getTableConfig(table);
  for (const column of config.columns) {
    const isFloatMoneyType = FLOAT_MONEY_TYPES.has(column.columnType);
    if (isFloatMoneyType && MONEY_SUFFIX_PATTERN.test(column.name)) {
      moneySuffixOffenders.push(`${config.name}.${column.name} (${column.columnType})`);
    }
    if (isFloatMoneyType) {
      anyFloatOffenders.push(`${config.name}.${column.name} (${column.columnType})`);
    }
  }
}

if (moneySuffixOffenders.length > 0) {
  fail(moneySuffixOffenders, 'money-suffixed column(s) using numeric/real/double-precision instead of integer minor units');
  failed = true;
}

if (anyFloatOffenders.length > 0) {
  fail(anyFloatOffenders, 'numeric/real/double-precision column(s) exist anywhere in the baseline schema');
  failed = true;
}

if (failed) {
  console.error(
    '\nSpec 003 AC-1: every monetary value is its own `<base>_amount_minor_units integer` + ' +
      '`<base>_currency_code text` pair (see moneyColumns() in lib/db/schema.ts) — never numeric/float/double.',
  );
  process.exit(1);
}

console.log('check:schema-money-lint PASSED — no numeric/real/double-precision money columns found.');
