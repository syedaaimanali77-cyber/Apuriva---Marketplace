import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEMO_CUSTOMER_NAMES,
  DEMO_PROVIDER_NAMES,
  demoDisplayName,
  demoEmail,
  isDemoDisplayName,
  isUndeliverableDemoEmail,
} from './identity';

/** Spec 045 §3.4 (AC-3, AC-6) — synthetic identity. */
describe('lib/demo/identity', () => {
  it('suffixes every display name with "(Demo)", exactly once', () => {
    expect(demoDisplayName('Ayesha')).toBe('Ayesha (Demo)');
    expect(demoDisplayName('  Ayesha ')).toBe('Ayesha (Demo)');
    expect(demoDisplayName('Ayesha (Demo)')).toBe('Ayesha (Demo)');
    for (const name of [...DEMO_CUSTOMER_NAMES, ...DEMO_PROVIDER_NAMES]) {
      expect(isDemoDisplayName(demoDisplayName(name))).toBe(true);
    }
    expect(isDemoDisplayName('Ayesha')).toBe(false);
    expect(isDemoDisplayName(null)).toBe(false);
  });

  it('builds demo+<uuid>@example.invalid emails, undeliverable by construction (RFC 2606)', () => {
    const id = randomUUID();
    const email = demoEmail(id);
    expect(email).toBe(`demo+${id}@example.invalid`);
    expect(isUndeliverableDemoEmail(email)).toBe(true);
    expect(email.endsWith('.invalid')).toBe(true);
    expect(isUndeliverableDemoEmail('someone@example.com')).toBe(false);
    expect(isUndeliverableDemoEmail(undefined)).toBe(false);
  });

  it('uses no real-looking personal data: placeholder names only', () => {
    expect(new Set(DEMO_CUSTOMER_NAMES).size).toBe(DEMO_CUSTOMER_NAMES.length);
    expect(new Set(DEMO_PROVIDER_NAMES).size).toBe(DEMO_PROVIDER_NAMES.length);
  });
});
