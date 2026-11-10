/**
 * E.164 phone number shape check (spec 005 §3 `RequestOtpRequest.phoneNumber`). Not a
 * country-specific formatter — spec 005 §5 explicitly requires a country-aware formatter on the
 * client, not a Pakistan-hardcoded one; the server only enforces the wire format.
 */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function isValidE164(phoneNumber: string): boolean {
  return E164_PATTERN.test(phoneNumber);
}
