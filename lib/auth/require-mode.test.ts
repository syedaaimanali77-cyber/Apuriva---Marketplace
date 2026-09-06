import { describe, expect, it } from 'vitest';
import { requireActiveMode } from './require-mode';

describe('requireActiveMode (spec 006 AC-3)', () => {
  it('allows a session already in the required mode', () => {
    expect(() => requireActiveMode({ activeMode: 'provider' }, 'provider')).not.toThrow();
    expect(() => requireActiveMode({ activeMode: 'customer' }, 'customer')).not.toThrow();
  });

  it('rejects a customer-mode session attempting a provider-only action with 403 FORBIDDEN', () => {
    try {
      requireActiveMode({ activeMode: 'customer' }, 'provider');
      expect.unreachable('expected requireActiveMode to throw');
    } catch (err: any) {
      expect(err.code).toBe('FORBIDDEN');
      expect(err.status).toBe(403);
    }
  });

  it('rejects a provider-mode session attempting a customer-only action with 403 FORBIDDEN', () => {
    try {
      requireActiveMode({ activeMode: 'provider' }, 'customer');
      expect.unreachable('expected requireActiveMode to throw');
    } catch (err: any) {
      expect(err.code).toBe('FORBIDDEN');
      expect(err.status).toBe(403);
    }
  });
});
