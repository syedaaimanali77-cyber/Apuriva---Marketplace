import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema';

const FLOAT_MONEY_TYPES = new Set(['PgNumeric', 'PgNumericNumber', 'PgNumericBigInt', 'PgReal', 'PgDoublePrecision']);

function allTables(): PgTable[] {
  return Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[];
}

describe('schema lint (spec 003)', () => {
  const tables = allTables().map((t) => ({ table: t, config: getTableConfig(t) }));

  it('AC-1: no numeric/real/double-precision column exists anywhere in the baseline schema', () => {
    const offenders: string[] = [];
    for (const { config } of tables) {
      for (const column of config.columns) {
        if (FLOAT_MONEY_TYPES.has(column.columnType)) {
          offenders.push(`${config.name}.${column.name} (${column.columnType})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AC-2: every timestamp column is timestamptz (withTimezone), never a bare timestamp', () => {
    const offenders: string[] = [];
    for (const { config } of tables) {
      for (const column of config.columns) {
        if (column.columnType === 'PgTimestamp' || column.columnType === 'PgTimestampString') {
          // @ts-expect-error -- withTimezone exists on the concrete PgTimestamp column class
          if (!column.withTimezone) offenders.push(`${config.name}.${column.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AC-4: every foreign-key column has its own covering btree index', () => {
    const offenders: string[] = [];
    for (const { config } of tables) {
      const indexedFirstColumns = new Set(
        config.indexes.map((index) => index.config.columns[0]).map((col) => (col as { name: string }).name),
      );
      for (const fk of config.foreignKeys) {
        const [column] = fk.reference().columns;
        if (!indexedFirstColumns.has(column.name)) {
          offenders.push(`${config.name}.${column.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AC-4: every foreign key defaults to RESTRICT (no CASCADE/SET NULL at baseline)', () => {
    const offenders: string[] = [];
    for (const { config } of tables) {
      for (const fk of config.foreignKeys) {
        if (fk.onDelete !== 'restrict') {
          offenders.push(`${config.name} -> ${fk.onDelete}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AC-5: no jsonb column exists on any baseline table yet (feature-specific, owned by later specs)', () => {
    const offenders: string[] = [];
    for (const { config } of tables) {
      for (const column of config.columns) {
        if (column.columnType === 'PgJsonb' || column.columnType === 'PgJson') {
          offenders.push(`${config.name}.${column.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every table has id/created_at/updated_at/version (baseline identity+audit+concurrency)', () => {
    const offenders: string[] = [];
    for (const { config } of tables) {
      const names = new Set(config.columns.map((c) => c.name));
      for (const required of ['id', 'created_at', 'updated_at', 'version']) {
        if (!names.has(required)) offenders.push(`${config.name} missing ${required}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
