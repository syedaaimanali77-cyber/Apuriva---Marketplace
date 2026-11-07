/**
 * Spec 045 §3.3 — the bundled portfolio placeholder: a plain 96×64 PNG in a neutral tint, embedded so it
 * ships with the code (no read from `public/` at run time, which a hosted build does not guarantee). It is
 * deliberately a blank tile, never a photograph, so a seeded portfolio can never be mistaken for real work.
 */
export const PLACEHOLDER_IMAGE_MIME = 'image/png';

const PLACEHOLDER_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAaUlEQVR42u3QMQ0AAAgDsPm3yUvQgANujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/FpOvu9CXhfrFAAAAAElFTkSuQmCC';

export function placeholderImageBytes(): Buffer {
  return Buffer.from(PLACEHOLDER_IMAGE_BASE64, 'base64');
}
