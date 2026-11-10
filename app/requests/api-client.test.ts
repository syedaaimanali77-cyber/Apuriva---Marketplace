// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api-client';

/**
 * Regression cover for the `TypeError: Failed to fetch` crash on `/requests`.
 *
 * `fetch` REJECTS rather than resolving whenever the request never completed — the dev server
 * recompiling mid-request, a dropped connection, an offline browser. `apiFetch` used to `await`
 * that call unguarded, so the rejection escaped the helper, escaped the page's `load` callback and
 * became an unhandled rejection inside `useEffect`, which Next's dev overlay reports as a runtime
 * TypeError. The screens each already branch on `!result.ok`, so the fix is to report the failure
 * in that same shape rather than to throw.
 */
describe('apiFetch (requests screens)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves with NETWORK_ERROR instead of throwing when fetch rejects', async () => {
    // Exactly what a browser throws when the request never reaches the server.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));

    const result = await apiFetch<unknown>('/api/v1/requests?filter=active&limit=20&offset=0');

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'NETWORK_ERROR', message: 'We could not reach the server.' });
  });

  it('never rejects on a network failure, whatever the rejection value is', async () => {
    for (const thrown of [new TypeError('Failed to fetch'), new Error('network down'), 'boom', undefined]) {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw thrown;
      }));
      // The load-bearing property: the caller's `await` must settle, never blow up.
      await expect(apiFetch<unknown>('/api/v1/requests')).resolves.toMatchObject({ ok: false });
    }
  });

  it('unwraps a successful paged response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'r1' }], page: { limit: 20, offset: 0, total: 1, nextOffset: null } }),
    })));

    const result = await apiFetch<{ id: string }[]>('/api/v1/requests');

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ id: 'r1' }]);
    expect(result.page).toEqual({ limit: 20, offset: 0, total: 1, nextOffset: null });
  });

  it('still returns ok for 204 without parsing a body', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json })));

    expect(await apiFetch<void>('/api/v1/requests/r1', { method: 'DELETE' })).toEqual({ ok: true });
    expect(json).not.toHaveBeenCalled();
  });

  it("surfaces the server's own error body — a real API error is never disguised as NETWORK_ERROR", async () => {
    // The endpoint answers 401 with a proper envelope when the session is missing; that is a
    // server answer, not a network failure, and must reach the caller unchanged.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ status: 401, code: 'UNAUTHENTICATED', message: 'No valid session.' }),
    })));

    const result = await apiFetch<unknown>('/api/v1/requests');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHENTICATED');
    expect(result.error?.message).toBe('No valid session.');
  });

  it('does not disguise a malformed success body as a network failure', async () => {
    // A response that arrived but whose body will not parse is still a server answer.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    })));

    const result = await apiFetch<unknown>('/api/v1/requests');

    expect(result.ok).toBe(true);
    expect(result.data).toBeUndefined();
  });
});
