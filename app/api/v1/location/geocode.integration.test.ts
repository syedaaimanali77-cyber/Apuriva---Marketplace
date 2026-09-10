import { describe, expect, it, beforeEach } from 'vitest';
import { POST as geocode } from './geocode/route';
import { POST as reverseGeocode } from './reverse-geocode/route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { isDatabaseReachable } from './location-test-support';

const dbReachable = await isDatabaseReachable();

/** These two routes don't touch the DB themselves, but every integration suite in this repo
 * gates on `isDatabaseReachable()` for consistency with the rest of the sandboxed test run. */
describe.skipIf(!dbReachable)('POST /api/v1/location/geocode & reverse-geocode (spec 012, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('AC-6: geocodes address text through the sandbox vendor for a guest caller', async () => {
    const res = await geocode(
      new Request('http://localhost/api/v1/location/geocode', {
        method: 'POST',
        body: JSON.stringify({ address: '123 Main Street, Lahore' }),
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(typeof data.latitude).toBe('number');
    expect(typeof data.longitude).toBe('number');
    expect(data.structured.line1).toBe('123 Main Street, Lahore');
    expect(data.approxAreaLabel).toBeTruthy();
  });

  it('returns 400 VALIDATION_ERROR when address is missing', async () => {
    const res = await geocode(new Request('http://localhost/api/v1/location/geocode', { method: 'POST', body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 GEOCODING_FAILED when the vendor cannot resolve the address', async () => {
    const res = await geocode(
      new Request('http://localhost/api/v1/location/geocode', {
        method: 'POST',
        body: JSON.stringify({ address: 'this is unresolvable' }),
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('GEOCODING_FAILED');
  });

  it('reverse-geocodes coordinates back into a GeocodeResultDto, not a saved AddressDto', async () => {
    const res = await reverseGeocode(
      new Request('http://localhost/api/v1/location/reverse-geocode', {
        method: 'POST',
        body: JSON.stringify({ latitude: 31.5204, longitude: 74.3587 }),
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.latitude).toBe(31.5204);
    expect(data.longitude).toBe(74.3587);
    expect(data.id).toBeUndefined();
    expect(data.label).toBeUndefined();
  });

  it('rate-limits repeated geocode calls under the location domain', async () => {
    let lastStatus = 200;
    for (let i = 0; i < 61; i++) {
      const res = await geocode(
        new Request('http://localhost/api/v1/location/geocode', {
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ address: `Address number ${i}` }),
        }),
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
