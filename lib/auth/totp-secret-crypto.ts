import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './secret';

/**
 * At-rest encryption for `AdminProfile.totp_secret_encrypted` (spec 005 §4) — AES-256-GCM.
 * Stored format: `<ivHex>:<authTagHex>:<ciphertextHex>`.
 */
export function encryptTotpSecret(secretBase32: string): string {
  const key = deriveKey('totp-secret-encryption');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptTotpSecret(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) throw new Error('Malformed encrypted TOTP secret.');

  const key = deriveKey('totp-secret-encryption');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
