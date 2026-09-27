import { afterEach, describe, expect, it } from 'vitest';
import { getOAuthProvider, OAuthProviderUnavailable } from './oauth-provider';

const originalNodeEnv = process.env.NODE_ENV;
function setNodeEnv(value: string | undefined): void {
  // `NODE_ENV` is typed as a readonly union in Next's ambient types; tests legitimately flip it.
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe('getOAuthProvider (spec 005 AC-4)', () => {
  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  it.each(['google', 'apple'] as const)('refuses the %s sandbox adapter under NODE_ENV=production', (name) => {
    setNodeEnv('production');
    expect(() => getOAuthProvider(name)).toThrow(OAuthProviderUnavailable);
  });

  it.each(['google', 'apple'] as const)('returns the %s sandbox adapter outside production, clearly marked', (name) => {
    const provider = getOAuthProvider(name);
    expect(provider.name).toBe(name);
    expect(provider.isSandbox).toBe(true);
  });

  it('reads NODE_ENV on every call — a warmed call cannot bypass the guard', () => {
    getOAuthProvider('google');
    setNodeEnv('production');
    expect(() => getOAuthProvider('google')).toThrow(OAuthProviderUnavailable);
  });

  it('keeps deterministic sandbox identities: same code, same identity; opaque codes land in the reserved .invalid domain', async () => {
    const provider = getOAuthProvider('google');
    const a = await provider.exchangeCode('dev-code');
    const b = await provider.exchangeCode('dev-code');
    expect(a).toEqual(b);
    expect(a.email).toMatch(/@sandbox\.oauth\.invalid$/);
    expect((await getOAuthProvider('apple').exchangeCode('dev-code')).providerUserId).not.toBe(a.providerUserId);
  });
});
