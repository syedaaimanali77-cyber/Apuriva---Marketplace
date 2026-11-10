import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { POST as interpret } from './interpret/route';
import { GET as search } from './route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createCategory, createProviderProfile, createService, isDatabaseReachable, linkProviderService } from './search-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('POST /api/v1/search/interpret (spec 013 AC-1/AC-5, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('AC-1: extracts intent and resolves a real serviceId, but returns no results itself', async () => {
    // Uniquely-named ("Electrician <uuid>") so this test's own row is the only ILIKE match —
    // the query text below still says plain "electrician" (a real user never types the suffix);
    // resolution only needs *a* matching published service to exist, not this literal row.
    const suffix = randomUUID().slice(0, 8);
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: `Electrician ${suffix}` });
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);

    const res = await interpret(
      new Request('http://localhost/api/v1/search/interpret', {
        method: 'POST',
        body: JSON.stringify({ text: 'Need an electrician tomorrow around DHA, preferably under Rs. 3,000' }),
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.serviceId).toBeTruthy();
    expect(data.date).toBe('tomorrow');
    expect(data.budgetMaxMinorUnits).toBe(300_000);
    expect(data.confidence).toBe('high');
    // The response is a suggestion only — no `providerId`/results field exists anywhere on it.
    expect(data).not.toHaveProperty('providerId');
    expect(data).not.toHaveProperty('results');
  });

  it('AC-1/never-fabricates: an interpreted intent must be passed through the real /search endpoint to get results', async () => {
    const suffix = randomUUID().slice(0, 8);
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: `Plumbing Service ${suffix}` });
    const { providerProfileId } = await createProviderProfile({ businessName: 'Real Plumber Co' });
    await linkProviderService(providerProfileId, serviceId);

    const interpretRes = await interpret(
      new Request('http://localhost/api/v1/search/interpret', {
        method: 'POST',
        body: JSON.stringify({ text: `plumbing service ${suffix}` }),
      }),
    );
    const { data: intent } = await interpretRes.json();

    const searchRes = await search(new Request(`http://localhost/api/v1/search?serviceId=${intent.serviceId}`));
    const { data: results } = await searchRes.json();
    expect(results[0].displayName).toBe('Real Plumber Co');
  });

  it('AC-5: a voice-transcribed string is interpreted through the exact same path as typed text', async () => {
    resetRateLimitState();
    const typedRes = await interpret(
      new Request('http://localhost/api/v1/search/interpret', { method: 'POST', body: JSON.stringify({ text: 'plumber near Gulberg tomorrow' }) }),
    );
    resetRateLimitState();
    const voiceRes = await interpret(
      new Request('http://localhost/api/v1/search/interpret', { method: 'POST', body: JSON.stringify({ text: 'plumber near Gulberg tomorrow' }) }),
    );
    const typed = await typedRes.json();
    const voice = await voiceRes.json();
    expect(typed.data).toEqual(voice.data);
  });

  it('returns 422 INTERPRETATION_LOW_CONFIDENCE when nothing can be extracted', async () => {
    // Pure filler words: the sandbox interpreter strips every one of them, leaving a genuinely
    // empty extraction — unlike a stray token (e.g. "xyz"), which is itself a legitimate, if
    // weak, service-name guess and correctly returns 200 with confidence: 'low' instead.
    const res = await interpret(
      new Request('http://localhost/api/v1/search/interpret', { method: 'POST', body: JSON.stringify({ text: 'need a' }) }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('INTERPRETATION_LOW_CONFIDENCE');
  });

  it('returns 200 with confidence "low" for a single weak signal, not a 422', async () => {
    const res = await interpret(
      new Request('http://localhost/api/v1/search/interpret', { method: 'POST', body: JSON.stringify({ text: 'xyz' }) }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.confidence).toBe('low');
  });

  it('returns 400 VALIDATION_ERROR when text is missing', async () => {
    const res = await interpret(new Request('http://localhost/api/v1/search/interpret', { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  describe('§9 feature flag fallback', () => {
    afterEach(() => {
      delete process.env.SEARCH_NL_INTERPRETATION_ENABLED;
    });

    it('falls back to keyword-only (422) when the interim flag is disabled', async () => {
      process.env.SEARCH_NL_INTERPRETATION_ENABLED = 'false';
      const res = await interpret(
        new Request('http://localhost/api/v1/search/interpret', {
          method: 'POST',
          body: JSON.stringify({ text: 'Need an electrician tomorrow under Rs. 3,000' }),
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('INTERPRETATION_LOW_CONFIDENCE');
    });
  });
});
