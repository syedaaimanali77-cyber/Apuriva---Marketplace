import { describe, expect, it } from 'vitest';
import { getIntentInterpreter, parseIntent } from './intent-interpreter';

describe('lib/ai/intent-interpreter (spec 013 AC-1/AC-5, sandbox adapter)', () => {
  it('extracts budget, date, area, and a service-name guess from a natural-language query', async () => {
    const result = await getIntentInterpreter().interpret('Need an electrician tomorrow around DHA, preferably under Rs. 3,000');
    expect(result.budgetMaxMinorUnits).toBe(300_000);
    expect(result.currencyCode).toBe('PKR');
    expect(result.date).toBe('tomorrow');
    expect(result.area).toMatch(/DHA/i);
    expect(result.serviceNameRaw).toMatch(/electrician/i);
  });

  it('treats a voice-transcribed string identically to typed text — no separate code path exists', async () => {
    const typed = await getIntentInterpreter().interpret('plumber near Gulberg tomorrow');
    const voiceTranscribed = await getIntentInterpreter().interpret('plumber near Gulberg tomorrow');
    expect(typed).toEqual(voiceTranscribed);
  });

  it('returns an empty extraction for empty/unresolvable text, never throwing', async () => {
    const result = await getIntentInterpreter().interpret('   ');
    expect(result).toEqual({});
  });

  it('is deterministic for the same input', async () => {
    const a = await getIntentInterpreter().interpret('need a plumber under 5000');
    const b = await getIntentInterpreter().interpret('need a plumber under 5000');
    expect(a).toEqual(b);
  });
});

/**
 * A REAL model's `search_intent` output is untrusted: whatever it returns, only the documented shape
 * survives, and money only as integer minor units (master spec §132 rule 5).
 */
describe('parseIntent — model output validation (spec 013 / spec 033 §3.10)', () => {
  it('keeps a well-formed intent exactly', () => {
    expect(parseIntent(JSON.stringify({ serviceNameRaw: 'plumber', area: 'Gulberg', date: 'tomorrow', budgetMaxMinorUnits: 300_000, currencyCode: 'PKR' }))).toEqual({
      serviceNameRaw: 'plumber',
      area: 'Gulberg',
      date: 'tomorrow',
      budgetMaxMinorUnits: 300_000,
      currencyCode: 'PKR',
    });
  });

  it('drops a fractional budget (never rounds it) and the currency that came with it', () => {
    expect(parseIntent(JSON.stringify({ serviceNameRaw: 'plumber', budgetMaxMinorUnits: 2500.5, currencyCode: 'PKR' }))).toEqual({ serviceNameRaw: 'plumber' });
  });

  it('drops a negative, unsafe, non-finite or non-numeric budget', () => {
    for (const budgetMaxMinorUnits of [-100, Number.MAX_SAFE_INTEGER + 2, '300000', null, true]) {
      expect(parseIntent(JSON.stringify({ area: 'DHA', budgetMaxMinorUnits, currencyCode: 'PKR' })), String(budgetMaxMinorUnits)).toEqual({ area: 'DHA' });
    }
    // JSON cannot carry NaN or Infinity; the literal text is not JSON at all.
    expect(parseIntent('{"budgetMaxMinorUnits": NaN}')).toEqual({});
  });

  it('keeps a zero budget, which is a real integer amount', () => {
    expect(parseIntent(JSON.stringify({ budgetMaxMinorUnits: 0, currencyCode: 'USD' }))).toEqual({ budgetMaxMinorUnits: 0, currencyCode: 'USD' });
  });

  it('keeps the budget but drops a malformed currency code', () => {
    // Lowercase, wrong length, a symbol, empty, a number — and shape-valid codes no currency has.
    for (const currencyCode of ['pkr', 'PK', 'PKRR', 'Rs', '', 5, 'ABC', 'QQQ']) {
      expect(parseIntent(JSON.stringify({ budgetMaxMinorUnits: 500_000, currencyCode })), String(currencyCode)).toEqual({ budgetMaxMinorUnits: 500_000 });
    }
  });

  it('drops an orphan currency code with no valid budget', () => {
    expect(parseIntent(JSON.stringify({ serviceNameRaw: 'electrician', currencyCode: 'PKR' }))).toEqual({ serviceNameRaw: 'electrician' });
  });

  it('returns {} for malformed JSON or a non-object, and ignores unexpected fields', () => {
    for (const output of ['not json', '{"serviceNameRaw": ', '[]', '"plumber"', '42', 'null']) {
      expect(parseIntent(output), output).toEqual({});
    }
    expect(parseIntent(JSON.stringify({ serviceNameRaw: 'painter', serviceId: 'forged-id', results: [1, 2], area: 7 }))).toEqual({ serviceNameRaw: 'painter' });
  });
});
