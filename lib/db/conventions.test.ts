import { getTableConfig, pgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { auditColumns, baseColumns, id, moneyColumns, moneyPairChecks, scheduledTimeColumns, version } from './schema';

describe('baseline conventions (spec 003 §4)', () => {
  it('baseColumns() gives every table id + audit + version, nothing else', () => {
    const scratch = pgTable('scratch_base_columns', { ...baseColumns() });
    const cfg = getTableConfig(scratch);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(['created_at', 'id', 'updated_at', 'version']);

    const idCol = cfg.columns.find((c) => c.name === 'id')!;
    expect(idCol.columnType).toBe('PgUUID');
    expect(idCol.primary).toBe(true);
    expect(idCol.hasDefault).toBe(true);

    for (const name of ['created_at', 'updated_at']) {
      const col = cfg.columns.find((c) => c.name === name)!;
      expect(col.columnType).toBe('PgTimestamp');
      expect(col.notNull).toBe(true);
      expect(col.hasDefault).toBe(true);
      // @ts-expect-error -- withTimezone exists on the concrete PgTimestamp column class
      expect(col.withTimezone).toBe(true);
    }

    const versionCol = cfg.columns.find((c) => c.name === 'version')!;
    expect(versionCol.columnType).toBe('PgInteger');
    expect(versionCol.notNull).toBe(true);
    expect(versionCol.hasDefault).toBe(true);
    expect(versionCol.default).toBe(1);
  });

  it('id() alone is reusable outside baseColumns() too', () => {
    const scratch = pgTable('scratch_id_only', { id: id() });
    expect(getTableConfig(scratch).columns[0]?.primary).toBe(true);
  });

  it('auditColumns()/version() are the same builders baseColumns() composes', () => {
    const scratch = pgTable('scratch_audit_version', { ...auditColumns(), version: version() });
    const cfg = getTableConfig(scratch);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(['created_at', 'updated_at', 'version']);
  });

  describe('moneyColumns (AC-1)', () => {
    it('produces its own amount/currency pair named after the given base, never numeric/real/double', () => {
      const scratch = pgTable('scratch_money', { ...baseColumns(), ...moneyColumns('deposit') });
      const cfg = getTableConfig(scratch);
      const amount = cfg.columns.find((c) => c.name === 'deposit_amount_minor_units')!;
      const currency = cfg.columns.find((c) => c.name === 'deposit_currency_code')!;
      expect(amount.columnType).toBe('PgInteger');
      expect(currency.columnType).toBe('PgText');
    });

    it('two calls with different bases never collide on column name', () => {
      const scratch = pgTable('scratch_money_two', {
        ...baseColumns(),
        ...moneyColumns('deposit'),
        ...moneyColumns('remainder'),
      });
      const names = getTableConfig(scratch).columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(
        expect.arrayContaining([
          'deposit_amount_minor_units',
          'deposit_currency_code',
          'remainder_amount_minor_units',
          'remainder_currency_code',
        ]),
      );
    });
  });

  describe('moneyPairChecks (AC-1)', () => {
    it('produces two named CHECK constraints scoped to the table and base name', () => {
      const checks = moneyPairChecks('example_table', 'deposit');
      expect(checks).toHaveLength(2);
      expect(checks[0].name).toBe('example_table_deposit_pair_ck');
      expect(checks[1].name).toBe('example_table_deposit_currency_format_ck');
    });

    it('is wired correctly end-to-end: both-null-or-both-set + currency format CHECKs land on the table', () => {
      const scratch = pgTable(
        'scratch_money_checked',
        { ...baseColumns(), ...moneyColumns('deposit') },
        () => moneyPairChecks('scratch_money_checked', 'deposit'),
      );
      const cfg = getTableConfig(scratch);
      expect(cfg.checks.map((c) => c.name).sort()).toEqual(
        ['scratch_money_checked_deposit_currency_format_ck', 'scratch_money_checked_deposit_pair_ck'].sort(),
      );
    });
  });

  describe('scheduledTimeColumns (AC-2)', () => {
    it('pairs a timestamptz instant with an IANA-timezone-identifier text column', () => {
      const scratch = pgTable('scratch_scheduled', { ...baseColumns(), ...scheduledTimeColumns('scheduled') });
      const cfg = getTableConfig(scratch);
      const at = cfg.columns.find((c) => c.name === 'scheduled_at')!;
      const tz = cfg.columns.find((c) => c.name === 'scheduled_timezone')!;
      expect(at.columnType).toBe('PgTimestamp');
      // @ts-expect-error -- withTimezone exists on the concrete PgTimestamp column class
      expect(at.withTimezone).toBe(true);
      expect(tz.columnType).toBe('PgText');
    });
  });
});
