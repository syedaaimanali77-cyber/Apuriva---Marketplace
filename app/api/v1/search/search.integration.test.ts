import { describe, expect, it, beforeEach } from 'vitest';
import { GET as search } from './route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import {
  createCategory,
  createProviderProfile,
  createService,
  createServicePackage,
  giveUserDefaultAddress,
  isDatabaseReachable,
  linkProviderService,
} from './search-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('GET /api/v1/search (spec 013 AC-1/AC-6, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('AC-1: returns real, authoritative results — a published service from an active provider', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: 'Electrician Repair' });
    const { providerProfileId } = await createProviderProfile({ businessName: 'Acme Electric' });
    await linkProviderService(providerProfileId, serviceId);

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`));
    expect(res.status).toBe(200);
    const { data, page } = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ providerId: providerProfileId, serviceId, displayName: 'Acme Electric' });
    expect(page).toMatchObject({ total: 1 });
  });

  it('never returns a draft/unpublished service', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { status: 'draft' });
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`));
    const { data } = await res.json();
    expect(data).toHaveLength(0);
  });

  it('never returns a service from a suspended/non-active provider', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId);
    const { providerProfileId } = await createProviderProfile({ lifecycleStatus: 'suspended' });
    await linkProviderService(providerProfileId, serviceId);

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`));
    const { data } = await res.json();
    expect(data).toHaveLength(0);
  });

  it('AC-6: identical parameters return deterministically identical, identically ordered results', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: 'Deterministic Cleaning' });
    for (let i = 0; i < 3; i++) {
      const { providerProfileId } = await createProviderProfile({ businessName: `Provider ${i}` });
      await linkProviderService(providerProfileId, serviceId);
    }

    const first = await (await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`))).json();
    const second = await (await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`))).json();
    expect(first.data.map((d: { providerId: string }) => d.providerId)).toEqual(second.data.map((d: { providerId: string }) => d.providerId));
  });

  it('resolves price from the cheapest matching package, "starting" when more than one exists', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { pricingModel: 'fixed' });
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);
    await createServicePackage(serviceId, providerProfileId, 500000);
    await createServicePackage(serviceId, providerProfileId, 300000);

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`));
    const { data } = await res.json();
    expect(data[0].priceDisplay).toMatchObject({ type: 'starting', amountMinorUnits: 300000, currencyCode: 'PKR' });
  });

  it('a quote-model service always displays as a quote, regardless of packages', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { pricingModel: 'quote' });
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`));
    const { data } = await res.json();
    expect(data[0].priceDisplay).toEqual({ type: 'quote' });
  });

  it('budgetMaxMinorUnits excludes a result whose resolved price exceeds it, keeps one within it', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { pricingModel: 'fixed' });
    const cheap = await createProviderProfile({ businessName: 'Cheap Co' });
    const expensive = await createProviderProfile({ businessName: 'Expensive Co' });
    await linkProviderService(cheap.providerProfileId, serviceId);
    await linkProviderService(expensive.providerProfileId, serviceId);
    await createServicePackage(serviceId, cheap.providerProfileId, 100000);
    await createServicePackage(serviceId, expensive.providerProfileId, 900000);

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}&budgetMaxMinorUnits=500000`));
    const { data } = await res.json();
    expect(data.map((d: { displayName: string }) => d.displayName)).toEqual(['Cheap Co']);
  });

  it('rating is never fabricated — absent from every result', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId);
    const { providerProfileId } = await createProviderProfile();
    await linkProviderService(providerProfileId, serviceId);

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}`));
    const { data } = await res.json();
    expect(data[0].rating).toBeUndefined();
  });

  it('sorts by distance and never exposes a raw/precise distance figure', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId);
    const near = await createProviderProfile({ businessName: 'Near Co' });
    const far = await createProviderProfile({ businessName: 'Far Co' });
    await linkProviderService(near.providerProfileId, serviceId);
    await linkProviderService(far.providerProfileId, serviceId);
    await giveUserDefaultAddress(near.userId, 31.521, 74.3587);
    await giveUserDefaultAddress(far.userId, 24.8607, 67.0011);

    const res = await search(
      new Request(`http://localhost/api/v1/search?serviceId=${serviceId}&lat=31.5204&lng=74.3587&sort=distance`),
    );
    const { data } = await res.json();
    expect(data.map((d: { displayName: string }) => d.displayName)).toEqual(['Near Co', 'Far Co']);
    for (const result of data) {
      expect(result.approxDistance).not.toMatch(/\d+\.\d+\s*(m|km)\b/);
    }
  });

  it('radiusKm excludes a provider outside the radius and one with no resolvable location', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId);
    const inRange = await createProviderProfile({ businessName: 'In Range' });
    const outOfRange = await createProviderProfile({ businessName: 'Out Of Range' });
    const noLocation = await createProviderProfile({ businessName: 'No Location' });
    await linkProviderService(inRange.providerProfileId, serviceId);
    await linkProviderService(outOfRange.providerProfileId, serviceId);
    await linkProviderService(noLocation.providerProfileId, serviceId);
    await giveUserDefaultAddress(inRange.userId, 31.521, 74.3587);
    await giveUserDefaultAddress(outOfRange.userId, 24.8607, 67.0011);

    const res = await search(
      new Request(`http://localhost/api/v1/search?serviceId=${serviceId}&lat=31.5204&lng=74.3587&radiusKm=5`),
    );
    const { data } = await res.json();
    expect(data.map((d: { displayName: string }) => d.displayName)).toEqual(['In Range']);
  });

  it('rejects an invalid sort value with 400 VALIDATION_ERROR', async () => {
    const res = await search(new Request('http://localhost/api/v1/search?sort=rating'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('paginates using the shared limit/offset/total/nextOffset envelope', async () => {
    const categoryId = await createCategory();
    const serviceId = await createService(categoryId, { name: 'Paginated Service' });
    for (let i = 0; i < 3; i++) {
      const { providerProfileId } = await createProviderProfile();
      await linkProviderService(providerProfileId, serviceId);
    }

    const res = await search(new Request(`http://localhost/api/v1/search?serviceId=${serviceId}&limit=2&offset=0`));
    const { data, page } = await res.json();
    expect(data).toHaveLength(2);
    expect(page).toMatchObject({ limit: 2, offset: 0, total: 3, nextOffset: 2 });
  });
});
