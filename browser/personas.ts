import os from 'node:os';
import path from 'node:path';

/**
 * Spec 046 §3.6 — the signed-in personas `browser/global-setup.ts` creates and the browser tests
 * reuse via `test.use({ storageState: personaStatePath('customer') })`. Sessions are written to the OS
 * temp directory, never into the repository.
 */
export const PERSONAS = ['customer', 'provider', 'admin'] as const;
export type Persona = (typeof PERSONAS)[number];

export const PLAYWRIGHT_TMP_DIR = path.join(os.tmpdir(), 'apuriva-playwright');
export const PERSONA_STATE_DIR = path.join(PLAYWRIGHT_TMP_DIR, 'auth');

export function personaStatePath(persona: Persona): string {
  return path.join(PERSONA_STATE_DIR, `${persona}.json`);
}
