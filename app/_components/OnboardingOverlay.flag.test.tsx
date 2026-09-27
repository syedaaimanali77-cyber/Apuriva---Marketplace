// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchClientFlag } from '@/lib/feature-flags/client';
import { OnboardingOverlay } from './OnboardingOverlay';

/**
 * Spec 041 X-6 — `onboarding-intro-v1` gates the spec 007 intro. Spec 007's own
 * `OnboardingOverlay.test.tsx` is untouched; this file covers only the flag.
 */
function stubFlags(response: { ok: boolean; body: unknown } | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, json: async () => response.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OnboardingOverlay × onboarding-intro-v1 (spec 041 X-6)', () => {
  it('shows the intro when the flag is on', async () => {
    const fetchMock = stubFlags({ ok: true, body: { data: { flags: { 'onboarding-intro-v1': true } } } });
    render(<OnboardingOverlay />);
    expect(await screen.findByRole('region', { name: 'Welcome' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feature-flags/effective', expect.objectContaining({ cache: 'no-store' }));
  });

  it('hides the intro when the flag is explicitly off', async () => {
    const fetchMock = stubFlags({ ok: true, body: { data: { flags: { 'onboarding-intro-v1': false } } } });
    render(<OnboardingOverlay />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('region', { name: 'Welcome' })).not.toBeInTheDocument();
  });

  it('shows the documented default (on) when the flag service is unreachable or answers an error', async () => {
    stubFlags(new Error('offline'));
    const { unmount } = render(<OnboardingOverlay />);
    expect(await screen.findByRole('region', { name: 'Welcome' })).toBeInTheDocument();
    unmount();
    stubFlags({ ok: false, body: {} });
    render(<OnboardingOverlay />);
    expect(await screen.findByRole('region', { name: 'Welcome' })).toBeInTheDocument();
  });

  it('never asks for flags once onboarding has been seen', async () => {
    const fetchMock = stubFlags({ ok: true, body: { data: { flags: { 'onboarding-intro-v1': true } } } });
    const { hasSeenOnboarding, markOnboardingSeen } = await import('@/lib/onboarding/seen-state');
    markOnboardingSeen();
    expect(hasSeenOnboarding()).toBe(true);
    render(<OnboardingOverlay />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Welcome' })).not.toBeInTheDocument();
  });
});

describe('fetchClientFlag (spec 041 §3.6 F3 client)', () => {
  it('returns the flag, or the fallback for a missing key, a non-boolean or a malformed body', async () => {
    stubFlags({ ok: true, body: { data: { flags: { a: false, b: 'no' } } } });
    expect(await fetchClientFlag('a', true)).toBe(false);
    expect(await fetchClientFlag('b', true)).toBe(true);
    expect(await fetchClientFlag('missing', false)).toBe(false);
    stubFlags({ ok: true, body: null });
    expect(await fetchClientFlag('a', true)).toBe(true);
  });
});
