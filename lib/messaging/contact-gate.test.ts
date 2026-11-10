import { describe, expect, it } from 'vitest';
import { applyContactPolicy } from './contact-gate';

/** Spec 025 §3 "Contact-sharing protection" — AC-2. */
describe('applyContactPolicy (spec 025 AC-2)', () => {
  it('masks before confirmation without altering surrounding text', () => {
    const input = 'Gate code is 4471, call me on 0300 123 4567 or ali@example.com — parking at the back.';
    const result = applyContactPolicy(input, false);

    expect(result.contactRedacted).toBe(true);
    expect(result.contactFlagged).toBe(false);
    expect(result.matchCount).toBe(2);
    expect(result.body).toBe('Gate code is 4471, call me on [contact removed] or [contact removed] — parking at the back.');
    expect(result.body).not.toContain('0300');
    expect(result.body).not.toContain('ali@example.com');
  });

  it('flags without masking after confirmation', () => {
    const input = 'I am outside, my number is 03001234567.';
    const result = applyContactPolicy(input, true);

    expect(result).toEqual({ body: input, contactRedacted: false, contactFlagged: true, matchCount: 1 });
  });

  it('never rejects a message and leaves legitimate service information untouched in both stages', () => {
    const legitimate = 'Price Rs. 3,500 agreed. Arrive 12/05/2026 at 10:30, flat 4B, 2nd floor, unit 17.';
    for (const allowed of [false, true]) {
      expect(applyContactPolicy(legitimate, allowed)).toEqual({
        body: legitimate,
        contactRedacted: false,
        contactFlagged: false,
        matchCount: 0,
      });
    }
  });

  it('detects Urdu/Arabic-Indic digit phone numbers (spec 019 detector reused)', () => {
    const result = applyContactPolicy('نمبر ۰۳۰۰۱۲۳۴۵۶۷ ہے', false);
    expect(result.contactRedacted).toBe(true);
    expect(result.body).toContain('[contact removed]');
  });

  it('is mutually exclusive: never both redacted and flagged', () => {
    for (const allowed of [false, true]) {
      const result = applyContactPolicy('email me at a@b.co', allowed);
      expect(result.contactRedacted && result.contactFlagged).toBe(false);
    }
  });
});
