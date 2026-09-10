import { describe, expect, it } from 'vitest';
import { getIntentInterpreter } from './intent-interpreter';

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
