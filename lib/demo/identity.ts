/**
 * Spec 045 §3.4 (AC-3, AC-6) — synthetic identity for seeded people.
 *
 *   - Display names are clearly synthetic and carry the "(Demo)" suffix.
 *   - Emails are `demo+<uuid>@example.invalid`: `.invalid` is reserved by RFC 2606 and can never be
 *     delivered, so even a real adapter could not reach a real recipient.
 *   - No phone number is assigned. §3.4 allows only the fictional `+1 555 0100`–`0199` range, but
 *     `users.phone_number` is unique and that range holds 100 numbers, which every concurrent demo set
 *     would share; leaving it empty keeps the rule (nothing outside the range is ever used) without
 *     making provisioning fail once a hundred sets exist.
 *   - No real personal data, ever.
 */

export const DEMO_NAME_SUFFIX = ' (Demo)';

export const DEMO_EMAIL_DOMAIN = 'example.invalid';

/** "Ayesha" → "Ayesha (Demo)". Idempotent, so a name can never carry the suffix twice. */
export function demoDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed.endsWith(DEMO_NAME_SUFFIX.trim()) ? trimmed : `${trimmed}${DEMO_NAME_SUFFIX}`;
}

export function isDemoDisplayName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.endsWith(DEMO_NAME_SUFFIX);
}

/** `demo+<uuid>@example.invalid` — undeliverable by construction. */
export function demoEmail(id: string): string {
  return `demo+${id}@${DEMO_EMAIL_DOMAIN}`;
}

export function isUndeliverableDemoEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && /^demo\+[0-9a-f-]{36}@example\.invalid$/.test(email);
}

/** First names used for seeded customers. Plainly placeholders; none belongs to a real person. */
export const DEMO_CUSTOMER_NAMES = ['Ayesha', 'Hamza', 'Sana', 'Usman', 'Mariam'] as const;

/** Business names used for seeded providers. */
export const DEMO_PROVIDER_NAMES = [
  'Sparkle Home Cleaning',
  'FixRight Repairs',
  'Swift Movers',
  'Glow Beauty Studio',
  'Frame & Flash Photography',
  'Precision Auto Care',
] as const;
