import { describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl, toTestDatabaseUrl } from './test-database';

describe('test database isolation', () => {
  it('points the normal development database at a sibling *_test database', () => {
    expect(toTestDatabaseUrl('postgresql://apuriva:apuriva@localhost:5432/apuriva')).toBe(
      'postgresql://apuriva:apuriva@localhost:5432/apuriva_test',
    );
  });

  it('keeps credentials, host, port and query parameters', () => {
    expect(toTestDatabaseUrl('postgresql://u:p@127.0.0.1:6543/app?sslmode=disable')).toBe(
      'postgresql://u:p@127.0.0.1:6543/app_test?sslmode=disable',
    );
  });

  it('leaves an already-isolated URL unchanged, so re-applying it never stacks suffixes', () => {
    const url = 'postgresql://apuriva:apuriva@localhost:5432/apuriva_test';
    expect(toTestDatabaseUrl(url)).toBe(url);
    expect(toTestDatabaseUrl(toTestDatabaseUrl(url))).toBe(url);
  });

  it('rejects a URL with no database name', () => {
    expect(() => toTestDatabaseUrl('postgresql://apuriva:apuriva@localhost:5432')).toThrow(/no database name/);
  });

  it('refuses the normal development database as a reset target', () => {
    expect(() => assertTestDatabaseUrl('postgresql://apuriva:apuriva@localhost:5432/apuriva')).toThrow(
      /Refusing to use database "apuriva"/,
    );
    expect(() => assertTestDatabaseUrl('postgresql://apuriva:apuriva@localhost:5432/apuriva_testing')).toThrow();
  });

  it('accepts an isolated *_test database', () => {
    expect(assertTestDatabaseUrl('postgresql://apuriva:apuriva@localhost:5432/apuriva_test')).toBe('apuriva_test');
  });

  it('runs with DATABASE_URL already pointed at an isolated database (set by vitest.config.ts)', () => {
    if (process.env.DATABASE_URL) {
      expect(() => assertTestDatabaseUrl(process.env.DATABASE_URL!)).not.toThrow();
    }
  });
});
