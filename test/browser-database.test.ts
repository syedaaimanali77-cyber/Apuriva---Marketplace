import { describe, expect, it } from 'vitest';
import { assertBrowserDatabaseUrl, resetBrowserDatabase, toBrowserDatabaseUrl } from './browser-database';

describe('browser test database (spec 046 §3.6)', () => {
  it.each([
    ['postgresql://u:p@localhost:5432/apuriva', 'postgresql://u:p@localhost:5432/apuriva_browser_test'],
    ['postgresql://u:p@localhost:5432/apuriva_test', 'postgresql://u:p@localhost:5432/apuriva_browser_test'],
    ['postgresql://u:p@localhost:5432/apuriva_browser_test', 'postgresql://u:p@localhost:5432/apuriva_browser_test'],
  ])('%s → %s (never the dev database, never Vitest’s)', (input, expected) => {
    expect(toBrowserDatabaseUrl(input)).toBe(expected);
  });

  it('refuses a URL without a database name', () => {
    expect(() => toBrowserDatabaseUrl('postgresql://u:p@localhost:5432/')).toThrow(/no database name/);
  });

  it('only a local *_browser_test database may be reset', () => {
    expect(assertBrowserDatabaseUrl('postgresql://u:p@localhost:5432/apuriva_browser_test')).toBe('apuriva_browser_test');
    expect(assertBrowserDatabaseUrl('postgresql://u:p@127.0.0.1:5432/x_browser_test')).toBe('x_browser_test');
    expect(() => assertBrowserDatabaseUrl('postgresql://u:p@localhost:5432/apuriva')).toThrow(/_test/);
    expect(() => assertBrowserDatabaseUrl('postgresql://u:p@localhost:5432/apuriva_test')).toThrow(/_browser_test/);
    expect(() => assertBrowserDatabaseUrl('postgresql://u:p@db.example.com:5432/apuriva_browser_test')).toThrow(/non-local/);
  });

  it('resetBrowserDatabase refuses before connecting to anything', async () => {
    await expect(resetBrowserDatabase('postgresql://u:p@localhost:5432/apuriva')).rejects.toThrow(/_test/);
  });
});
