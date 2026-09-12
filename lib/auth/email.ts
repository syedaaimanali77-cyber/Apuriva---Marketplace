/** Basic shape check (spec 005 §3 `400 VALIDATION_ERROR` — "malformed ... email"). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

export const MIN_PASSWORD_LENGTH = 8;

export function isValidPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}
