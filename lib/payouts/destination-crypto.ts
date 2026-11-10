import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from '@/lib/auth/secret';

/**
 * Spec 024 §3.9 — at-rest encryption for `payout_methods.destination_token_encrypted`, AES-256-GCM.
 *
 * The exact idiom of `lib/auth/totp-secret-crypto.ts` (spec 005), with its own domain-separated
 * subkey, so a key derived for one purpose can never decrypt another. Stored format:
 * `<ivHex>:<authTagHex>:<ciphertextHex>`. The plaintext is an opaque RAIL handle, never an account
 * number, and it never leaves the server in any DTO, log, export or statement (AC-10).
 */
const PURPOSE = 'payout-destination-token-encryption';

export function encryptDestinationToken(token: string): string {
  const key = deriveKey(PURPOSE);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptDestinationToken(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) throw new Error('Malformed encrypted destination token.');

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(PURPOSE), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
}

/** True when the stored value decrypts under the current key — a usable destination (§3.6 Pass C). */
export function isDecryptableDestinationToken(stored: string): boolean {
  try {
    return decryptDestinationToken(stored).length > 0;
  } catch {
    return false;
  }
}
