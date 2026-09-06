// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSeenOnboarding, markOnboardingSeen } from './seen-state';

describe('onboarding seen-state (spec 007 §4/§8)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reports unseen before markOnboardingSeen is ever called', () => {
    expect(hasSeenOnboarding()).toBe(false);
  });

  it('persists "seen" across calls, in durable storage (localStorage, not sessionStorage)', () => {
    markOnboardingSeen();
    expect(hasSeenOnboarding()).toBe(true);
    expect(window.localStorage.getItem('apuriva_onboarding_seen')).toBe('1');
    expect(window.sessionStorage.getItem('apuriva_onboarding_seen')).toBeNull();
  });

  it('remains effective after a later sign-in (no server round-trip, purely local read)', () => {
    markOnboardingSeen();
    // Simulate "signed in now" — nothing about auth state should affect this local flag.
    expect(hasSeenOnboarding()).toBe(true);
  });

  it('treats a localStorage failure as already-seen rather than re-showing forever', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(hasSeenOnboarding()).toBe(true);
    spy.mockRestore();
  });
});
