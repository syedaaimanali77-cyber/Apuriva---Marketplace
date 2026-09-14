import { describe, expect, it } from 'vitest';
import { CONTACT_PLACEHOLDER, redactContactInfo, redactItems, redactOptional } from './contact-redaction';

/**
 * Spec 019 AC-7 / §3 "Contact redaction". The must-pass-through list is the product rule, not a nicety:
 * master spec §54 forbids aggressively blocking legitimate service information.
 */
describe('contact redaction (spec 019 AC-7)', () => {
  it('redacts emails', () => {
    const result = redactContactInfo('Write to ali.khan+work@example.co.uk about the AC.');
    expect(result.text).toBe(`Write to ${CONTACT_PLACEHOLDER} about the AC.`);
    expect(result.redacted).toBe(true);
    expect(result.count).toBe(1);
  });

  it('redacts 10+ digit phone runs with spaces, dashes, dots, parentheses and +', () => {
    for (const input of ['03001234567', '0300-1234567', '+92 300 1234567', '(0300) 123 4567', '0300.123.4567', 'wa.me/923001234567']) {
      const result = redactContactInfo(`Call ${input} please`);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toContain(CONTACT_PLACEHOLDER);
      expect(result.text, input).not.toMatch(/\d{4}/);
    }
  });

  it('redacts Urdu/Arabic-Indic digit phone runs', () => {
    // U+0660–U+0669 — eleven Arabic-Indic digits, the same shape as 03001234567.
    const result = redactContactInfo('رابطہ ٠٣٠٠١٢٣٤٥٦٧');
    expect(result.redacted).toBe(true);
    expect(result.text).toContain(CONTACT_PLACEHOLDER);
  });

  it('leaves prices, ranges, dates, times, addresses and quantities unchanged', () => {
    const legitimate = [
      'Rs. 3,500 for the full job',
      'Budget is 3500-4000',
      'PKR 12000 including parts',
      'Booked for 12/05/2026',
      'Any time 10:30 - 11:30 works',
      'House 12, Street 4, F-7/2',
      '2 AC units, 1.5 ton each',
      'Model 2024 inverter',
      'call me after 5',
      'my email is on my profile',
    ];
    for (const input of legitimate) {
      const result = redactContactInfo(input);
      expect(result.text, input).toBe(input);
      expect(result.redacted, input).toBe(false);
    }
  });

  it('counts every match and handles mixed content', () => {
    const result = redactContactInfo('a@b.com or 0300 123 4567 — price stays 3,500');
    expect(result.count).toBe(2);
    expect(result.text).toContain('3,500');
    expect(result.text).not.toContain('a@b.com');
    expect(result.text).not.toContain('4567');
  });

  it('redactOptional keeps null as null and redactItems preserves order', () => {
    expect(redactOptional(null)).toEqual({ text: null, count: 0 });
    expect(redactOptional('no contacts here')).toEqual({ text: 'no contacts here', count: 0 });

    const items = redactItems(['Labour', 'Call 03001234567', 'Parts']);
    expect(items.items[0]).toBe('Labour');
    expect(items.items[1]).toBe(`Call ${CONTACT_PLACEHOLDER}`);
    expect(items.items[2]).toBe('Parts');
    expect(items.count).toBe(1);
  });

  it('is pure: the same input always produces the same output', () => {
    const input = 'reach me at 0300-1234567 or ali@example.com';
    expect(redactContactInfo(input)).toEqual(redactContactInfo(input));
  });
});
