import { describe, expect, it, beforeEach } from 'vitest';
import { GET as listAddresses, POST as createAddress } from './addresses/route';
import { DELETE as deleteAddress, PATCH as updateAddress } from './addresses/[id]/route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, registerAndLogin } from './location/location-test-support';

const dbReachable = await isDatabaseReachable();

function validAddressBody(overrides: Record<string, unknown> = {}) {
  return {
    label: 'Home',
    structured: { line1: 'House 12, Street 5', area: 'Gulberg', city: 'Lahore', country: 'Pakistan' },
    latitude: 31.5204,
    longitude: 74.3587,
    ...overrides,
  };
}

describe.skipIf(!dbReachable)('saved addresses API (spec 012 §3, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('requires a session to list or create addresses', async () => {
    const listRes = await listAddresses(new Request('http://localhost/api/v1/addresses', { method: 'GET' }));
    expect(listRes.status).toBe(401);

    const createRes = await createAddress(
      new Request('http://localhost/api/v1/addresses', { method: 'POST', body: JSON.stringify(validAddressBody()) }),
    );
    expect(createRes.status).toBe(401);
  });

  it('creates, lists, updates, and deletes a saved address; owner-scoped throughout', async () => {
    const user = await registerAndLogin();

    const createRes = await createAddress(
      authenticatedRequest('http://localhost/api/v1/addresses', user.sessionId, user.csrfToken, {
        method: 'POST',
        body: validAddressBody({ isDefault: true }),
      }),
    );
    expect(createRes.status).toBe(201);
    const { data: created } = await createRes.json();
    expect(created).toMatchObject({
      label: 'Home',
      isDefault: true,
      latitude: 31.5204,
      longitude: 74.3587,
      structured: { line1: 'House 12, Street 5', area: 'Gulberg', city: 'Lahore', country: 'Pakistan' },
    });

    const listRes = await listAddresses(
      authenticatedRequest('http://localhost/api/v1/addresses', user.sessionId, user.csrfToken, { method: 'GET' }),
    );
    expect(listRes.status).toBe(200);
    const { data: list } = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);

    const patchRes = await updateAddress(
      authenticatedRequest(`http://localhost/api/v1/addresses/${created.id}`, user.sessionId, user.csrfToken, {
        method: 'PATCH',
        body: { label: 'Home (updated)' },
      }),
    );
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).data.label).toBe('Home (updated)');

    const deleteRes = await deleteAddress(
      authenticatedRequest(`http://localhost/api/v1/addresses/${created.id}`, user.sessionId, user.csrfToken, { method: 'DELETE' }),
    );
    expect(deleteRes.status).toBe(204);

    const listAfterDelete = await listAddresses(
      authenticatedRequest('http://localhost/api/v1/addresses', user.sessionId, user.csrfToken, { method: 'GET' }),
    );
    expect((await listAfterDelete.json()).data).toHaveLength(0);
  });

  it('setting isDefault unsets it on the caller\'s other addresses', async () => {
    const user = await registerAndLogin();

    const first = await createAddress(
      authenticatedRequest('http://localhost/api/v1/addresses', user.sessionId, user.csrfToken, {
        method: 'POST',
        body: validAddressBody({ label: 'First', isDefault: true }),
      }),
    );
    const firstId = (await first.json()).data.id;

    const second = await createAddress(
      authenticatedRequest('http://localhost/api/v1/addresses', user.sessionId, user.csrfToken, {
        method: 'POST',
        body: validAddressBody({ label: 'Second', isDefault: true }),
      }),
    );
    expect((await second.json()).data.isDefault).toBe(true);

    const listRes = await listAddresses(
      authenticatedRequest('http://localhost/api/v1/addresses', user.sessionId, user.csrfToken, { method: 'GET' }),
    );
    const { data: list } = await listRes.json();
    const first_ = list.find((a: { id: string }) => a.id === firstId);
    expect(first_.isDefault).toBe(false);
  });

  it('404s identically for a nonexistent address and another user\'s address (ownership hidden)', async () => {
    const owner = await registerAndLogin();
    const other = await registerAndLogin();

    const created = await createAddress(
      authenticatedRequest('http://localhost/api/v1/addresses', owner.sessionId, owner.csrfToken, {
        method: 'POST',
        body: validAddressBody(),
      }),
    );
    const addressId = (await created.json()).data.id;

    const otherTriesPatch = await updateAddress(
      authenticatedRequest(`http://localhost/api/v1/addresses/${addressId}`, other.sessionId, other.csrfToken, {
        method: 'PATCH',
        body: { label: 'Hijacked' },
      }),
    );
    expect(otherTriesPatch.status).toBe(404);
    expect((await otherTriesPatch.json()).code).toBe('ADDRESS_NOT_FOUND');

    const nonexistent = await updateAddress(
      authenticatedRequest('http://localhost/api/v1/addresses/00000000-0000-0000-0000-000000000000', other.sessionId, other.csrfToken, {
        method: 'PATCH',
        body: { label: 'X' },
      }),
    );
    expect(nonexistent.status).toBe(404);
    expect((await nonexistent.json()).code).toBe('ADDRESS_NOT_FOUND');
  });

  it('rejects invalid coordinates with 400 VALIDATION_ERROR', async () => {
    const user = await registerAndLogin();
    const res = await createAddress(
      authenticatedRequest('http://localhost/api/v1/addresses', user.sessionId, user.csrfToken, {
        method: 'POST',
        body: validAddressBody({ latitude: 200 }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});
