import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidE164 } from '@/lib/auth/phone';
import { ApiRouteError } from '@/lib/api/errors';

/**
 * Spec 042 AC-4 / D-11 — the generic validators stay country-neutral. Regression only: spec 042 adds no
 * per-country framework and changes neither validator; this pins that a valid NON-Pakistani phone number
 * or address is accepted by exactly the same rules as a Pakistani one.
 */
const inserted: Record<string, unknown>[] = [];

vi.mock('@/lib/db', () => {
  const tx = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(row);
          return [{ id: `row-${inserted.length}`, isDefault: false, ...row }];
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return { getDb: () => ({ transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }) };
});

const { createAddress } = await import('@/lib/location/addresses');

beforeEach(() => {
  inserted.length = 0;
});

describe('phone validation is plain E.164 (spec 042 AC-4)', () => {
  it('accepts a Pakistani number and non-Pakistani numbers by the same rule', () => {
    for (const phone of ['+923001234567', '+14155552671', '+442071838750', '+971501234567', '+8613800138000', '+61412345678']) {
      expect(isValidE164(phone), phone).toBe(true);
    }
  });

  it('rejects malformed input the same way whatever the country', () => {
    for (const phone of ['03001234567', '4155552671', '+0123456789', '+92 300 1234567', '+1', 'abc']) {
      expect(isValidE164(phone), phone).toBe(false);
    }
  });
});

describe('address validation is the country-neutral free-text structure (spec 042 AC-4)', () => {
  const base = { label: 'Home', latitude: 0, longitude: 0 };
  const addresses = [
    { structured: { line1: 'House 12, Street 5', area: 'Gulberg', city: 'Lahore', country: 'Pakistan' }, latitude: 31.52, longitude: 74.35 },
    { structured: { line1: '1600 Amphitheatre Pkwy', area: 'Mountain View', city: 'Mountain View', country: 'United States' }, latitude: 37.42, longitude: -122.08 },
    { structured: { line1: '10 Downing Street', area: 'Westminster', city: 'London', country: 'United Kingdom' }, latitude: 51.5, longitude: -0.12 },
    { structured: { line1: 'شارع الشيخ زايد', area: 'Trade Centre', city: 'دبي', country: 'الإمارات' }, latitude: 25.2, longitude: 55.27 },
  ];

  it('accepts a Pakistani and non-Pakistani addresses identically, storing the text exactly as entered', async () => {
    for (const address of addresses) {
      const dto = await createAddress('user-1', { ...base, ...address });
      expect(dto.label).toBe('Home');
      const stored = inserted.find((row) => 'structured' in row) as { structured: unknown } | undefined;
      expect(stored?.structured).toEqual(address.structured);
      inserted.length = 0;
    }
  });

  it('refuses a missing field the same way for any country — no Pakistan-specific format is enforced', async () => {
    const withoutCity = { ...base, structured: { line1: '1 Main St', area: 'Downtown', city: '', country: 'Canada' } };
    await expect(createAddress('user-1', withoutCity)).rejects.toBeInstanceOf(ApiRouteError);
  });
});
