import { describe, expect, it } from 'vitest';
import { isActiveMode } from './users';

describe('isActiveMode (spec 006 §3 mode validation)', () => {
  it.each(['customer', 'provider'])('accepts %s', (value) => {
    expect(isActiveMode(value)).toBe(true);
  });

  it.each([undefined, null, '', 'admin', 'Customer', 123, {}])('rejects %j', (value) => {
    expect(isActiveMode(value)).toBe(false);
  });
});
