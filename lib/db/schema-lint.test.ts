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

  it('AC-5: every jsonb column is an explicitly reviewed, documented exception — never a silent addition', () => {
    // Each entry here is a later spec's owning-spec-approved use of jsonb for a genuinely
    // variable, service-specific attribute (AC-5) — not core/queryable/relationship data. Adding
    // a jsonb column anywhere else fails this test until it's deliberately added here too.
    const ALLOWED_JSONB_COLUMNS: Record<string, string[]> = {
      // Spec 005 §4: variable per-event-type detail, never queried/filtered on directly.
      security_events: ['metadata'],
      // Spec 012 §4: geo hierarchy (city/area/country) — descriptive, never queried/filtered on.
      locations: ['geo_hierarchy'],
      // Spec 012 §4: structured address fields — descriptive, never queried/filtered on.
      addresses: ['structured'],
      // Spec 015 §4: a request's answer to one `ServiceField`, whose type is genuinely variable
      // per that field's own `type` (text/select/number/boolean/media). Read back as a whole to
      // rebuild `RequestDto.fieldValues`; never queried or filtered on.
      request_field_values: ['value'],
      // Spec 016 §4: a provider's `cities` coverage list — a short, unordered set of names
      // compared case-insensitively in application code (`lib/location/service-area.ts`), read
      // back whole and never queried or filtered on in SQL. The queryable parts of a service area
      // (mode, radius, centre address) are real relational columns precisely because they ARE
      // core/queryable data (AC-5).
      provider_service_areas: ['cities'],
      // Spec 017 4: the per-service ranking-weight override and an AI suggestion's proposed
      // weights. Both are a fixed nine-key factor->integer map read back whole and validated in
      // application code (lib/matching/weights.ts); never queried or filtered on in SQL. The
      // queryable part of matching config (`matching_pool_size`) is a real integer column.
      services: ['matching_weights'],
      matching_suggestions: ['suggested_weights'],
      // Spec 017 §4: the per-factor scoring breakdown (AC-2/AC-6) — a fixed nine-key
      // factor->{normalized,weight,available} map, read back whole for admin explainability and
      // never queried or filtered on in SQL. `score_micros` (the queryable/sortable part) is a
      // real integer column precisely because it IS core/queryable data.
      request_provider_matches: ['score_breakdown'],
    };

    const offenders: string[] = [];
    for (const { config } of tables) {
      for (const column of config.columns) {
        if (column.columnType === 'PgJsonb' || column.columnType === 'PgJson') {
          if (!(ALLOWED_JSONB_COLUMNS[config.name] ?? []).includes(column.name)) {
            offenders.push(`${config.name}.${column.name}`);
          }
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
