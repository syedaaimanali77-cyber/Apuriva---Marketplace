// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { peekResumeState } from './resume-state';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/explore/providers/123',
}));

// Imported after the mock so useAuthGate picks up the mocked next/navigation.
const { useAuthGate } = await import('./use-auth-gate');

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    clone() {
      return jsonResponse(status, body);
    },
    json: async () => body,
  } as unknown as Response;
}

describe('useAuthGate (spec 007 AC-3)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    push.mockClear();
  });

  it('passes a successful response straight through without redirecting', async () => {
    const { result } = renderHook(() => useAuthGate());
    const run = vi.fn().mockResolvedValue(jsonResponse(200, { data: { ok: true } }));

    const outcome = await result.current.guard({ actionType: 'save-provider' }, run);

    expect(outcome.redirectedToAuth).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(peekResumeState()).toBeNull();
  });

  it('on 401 UNAUTHENTICATED: saves resume state and redirects to login', async () => {
    const { result } = renderHook(() => useAuthGate());
    const run = vi.fn().mockResolvedValue(
      jsonResponse(401, { status: 401, code: 'UNAUTHENTICATED', message: 'No valid session.' }),
    );

    const outcome = await result.current.guard(
      { actionType: 'save-provider', payload: { providerId: 'p1' } },
      run,
    );

    expect(outcome.redirectedToAuth).toBe(true);
    expect(push).toHaveBeenCalledWith('/login');
    const saved = peekResumeState();
    expect(saved?.returnTo).toBe('/explore/providers/123');
    expect(saved?.actionType).toBe('save-provider');
    expect(saved?.payload).toEqual({ providerId: 'p1' });
  });

  it('respects a custom loginPath', async () => {
    const { result } = renderHook(() => useAuthGate());
    const run = vi.fn().mockResolvedValue(jsonResponse(401, { code: 'UNAUTHENTICATED' }));

    await result.current.guard({ actionType: 'x', loginPath: '/register' }, run);

    expect(push).toHaveBeenCalledWith('/register');
  });

  it('does NOT treat a 401 MFA_REQUIRED as a guest-needs-signup case (spec 005\'s own 401, different scenario)', async () => {
    const { result } = renderHook(() => useAuthGate());
    const run = vi.fn().mockResolvedValue(
      jsonResponse(401, { status: 401, code: 'MFA_REQUIRED', message: 'MFA verification required.' }),
    );

    const outcome = await result.current.guard({ actionType: 'save-provider' }, run);

    expect(outcome.redirectedToAuth).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(peekResumeState()).toBeNull();
  });

  it('does not redirect on other error statuses (e.g. 500)', async () => {
    const { result } = renderHook(() => useAuthGate());
    const run = vi.fn().mockResolvedValue(jsonResponse(500, { code: 'INTERNAL_ERROR' }));

    const outcome = await result.current.guard({ actionType: 'save-provider' }, run);

    expect(outcome.redirectedToAuth).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
