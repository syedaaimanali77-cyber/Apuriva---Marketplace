// @vitest-environment jsdom
//
// Spec 007 traceability: this is the guest-browse → identity-required action → signup/login →
// exact-action-resume flow (AC-3). The project has no browser-level E2E runner (no Playwright/
// Cypress config anywhere in the repo) and no real identity-requiring feature exists yet to click
// through in a real browser (specs 010-014/015+ own those features and haven't been built) — so
// this integration-style test exercises the full round trip through the actual AuthGate modules
// (resume-state, useAuthGate, AuthGateResumer, useResumedAction) end to end, standing in for a
// true E2E until a real guarded feature and an E2E runner both exist. See the implementation
// report for this gap.
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peekResumeState } from '@/lib/auth-gate/resume-state';
import { useAuthGate } from '@/lib/auth-gate/use-auth-gate';
import { useResumedAction } from '@/lib/auth-gate/use-resumed-action';

let currentPathname = '/explore/providers/123';
const push = vi.fn();
const replace = vi.fn((to: string) => {
  currentPathname = to;
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => currentPathname,
}));

const { AuthGateResumer } = await import('./AuthGateResumer');

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

describe('Guest → identity-required action → signup/login → resume (spec 007 AC-3, full round trip)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    push.mockClear();
    replace.mockClear();
    currentPathname = '/explore/providers/123';
  });

  it('resumes the exact in-progress action after the guest authenticates', async () => {
    // 1. Guest browses to a provider page and attempts an identity-required action
    //    (e.g. "Save provider"); the API rejects it as 401 UNAUTHENTICATED.
    const attemptSave = vi.fn().mockResolvedValue(
      jsonResponse(401, { status: 401, code: 'UNAUTHENTICATED', message: 'No valid session.' }),
    );
    const { result: gate } = renderHook(() => useAuthGate());
    const outcome = await gate.current.guard(
      { actionType: 'save-provider', payload: { providerId: 'p1' } },
      attemptSave,
    );
    expect(outcome.redirectedToAuth).toBe(true);
    expect(push).toHaveBeenCalledWith('/login'); // AuthGate sent them to spec 005's real login page

    // 2. Guest signs up/logs in (spec 005, out of scope here) and lands back on `/` — spec 005's
    //    login/register always redirect there, unmodified by this spec.
    currentPathname = '/';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { data: { activeMode: 'customer' } })));

    const { unmount } = render(<AuthGateResumer />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/explore/providers/123'));
    unmount();
    vi.unstubAllGlobals();

    // 3. The guest is now back on the original page — it reads back (and consumes) the exact
    //    action payload it was trying to perform before being interrupted.
    currentPathname = '/explore/providers/123';
    const { result: resumed } = renderHook(() => useResumedAction<{ providerId: string }>('save-provider'));
    await waitFor(() => expect(resumed.current).toEqual({ providerId: 'p1' }));

    // Single-use: nothing left to resume again.
    expect(peekResumeState()).toBeNull();
  });

  it('does not bounce the guest anywhere while still unauthenticated', async () => {
    const attemptSave = vi.fn().mockResolvedValue(jsonResponse(401, { code: 'UNAUTHENTICATED' }));
    const { result: gate } = renderHook(() => useAuthGate());
    await gate.current.guard({ actionType: 'save-provider' }, attemptSave);

    currentPathname = '/';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { code: 'UNAUTHENTICATED' })));

    render(<AuthGateResumer />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
    // The pending action survives, ready to be retried on the next navigation.
    expect(peekResumeState()?.actionType).toBe('save-provider');
    vi.unstubAllGlobals();
  });
});
