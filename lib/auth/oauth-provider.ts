import { createHash } from 'node:crypto';

/**
 * OAuth provider adapter (Google/Apple) — spec 005 AC-4. No real Google/Apple client
 * credentials exist in this environment, so — mirroring the SMS/OTP adapter pattern this spec
 * already decided on (§8 risk #1) — this ships behind a swappable interface with only a
 * sandbox/mock implementation for now. A real provider exchange (validating `code` against
 * Google's/Apple's token endpoint with real client credentials) is a later, separate
 * configuration change that implements this same interface.
 */
export interface OAuthExchangeResult {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
}

export interface OAuthProvider {
  exchangeCode(code: string): Promise<OAuthExchangeResult>;
}

/**
 * Sandbox implementation: never calls out to a real provider. If `code` is a JSON payload
 * (`{"email": "...", "providerUserId": "..."}`) it's used directly — lets tests/dev tooling
 * control the result deterministically. Otherwise a stable pseudo-identity is derived from the
 * code string itself, so the same `code` always maps to the same sandbox identity.
 */
class SandboxOAuthProvider implements OAuthProvider {
  constructor(private readonly providerName: 'google' | 'apple') {}

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    try {
      const parsed = JSON.parse(code) as Partial<OAuthExchangeResult>;
      if (parsed.email) {
        return {
          providerUserId: parsed.providerUserId ?? this.deriveId(code),
          email: parsed.email,
          emailVerified: parsed.emailVerified ?? true,
        };
      }
    } catch {
      // not a JSON payload — fall through to the deterministic derivation below
    }

    const id = this.deriveId(code);
    return { providerUserId: id, email: `${this.providerName}-${id}@sandbox.oauth.invalid`, emailVerified: true };
  }

  private deriveId(code: string): string {
    return createHash('sha256').update(`${this.providerName}:${code}`).digest('hex').slice(0, 16);
  }
}

const googleProvider = new SandboxOAuthProvider('google');
const appleProvider = new SandboxOAuthProvider('apple');

/** Only sandbox implementations are wired up for now — see file header. */
export function getOAuthProvider(name: 'google' | 'apple'): OAuthProvider {
  return name === 'google' ? googleProvider : appleProvider;
}
