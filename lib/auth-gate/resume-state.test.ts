// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearResumeState,
  consumeResumeState,
  isSafeInAppPath,
  isValidResumeState,
  peekResumeState,
  RESUME_STATE_TTL_MS,
  saveResumeState,
} from './resume-state';

describe('AuthGate resume state (spec 007 §4)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
  });

  describe('isSafeInAppPath (open-redirect prevention)', () => {
    it.each(['/explore', '/requests/new', '/'])('accepts in-app relative path %s', (path) => {
      expect(isSafeInAppPath(path)).toBe(true);
    });

    it.each([
      'https://evil.example.com/phish',
      'http://evil.example.com',
      '//evil.example.com/phish',
      '/\\evil.example.com',
      'javascript:alert(1)',
      'explore', // missing leading slash
      '',
      undefined,
      null,
      123,
    ])('rejects unsafe/non-in-app value %j', (value) => {
      expect(isSafeInAppPath(value)).toBe(false);
    });
  });

  describe('saveResumeState / peekResumeState (serialization + round-trip)', () => {
    it('round-trips returnTo, actionType, and payload exactly', () => {
      saveResumeState({ returnTo: '/explore/providers/123', actionType: 'save-provider', payload: { providerId: '123' } });
      const state = peekResumeState();
      expect(state).not.toBeNull();
      expect(state?.returnTo).toBe('/explore/providers/123');
      expect(state?.actionType).toBe('save-provider');
      expect(state?.payload).toEqual({ providerId: '123' });
      expect(state?.expiresAt).toBeGreaterThan(state!.savedAt);
    });

    it('defaults to an empty payload when none is given', () => {
      saveResumeState({ returnTo: '/explore', actionType: 'browse' });
      expect(peekResumeState()?.payload).toEqual({});
    });

    it('does not consume state on peek — a second peek still sees it', () => {
      saveResumeState({ returnTo: '/explore', actionType: 'browse' });
      expect(peekResumeState()).not.toBeNull();
      expect(peekResumeState()).not.toBeNull();
    });
  });

  describe('security constraints', () => {
    it('refuses to save when returnTo is not a safe in-app path (open-redirect guard)', () => {
      expect(() => saveResumeState({ returnTo: 'https://evil.example.com', actionType: 'x' })).toThrow();
      expect(peekResumeState()).toBeNull();
    });

    it.each(['password', 'otp', 'authToken', 'sessionSecret', 'cardNumber', 'cvv', 'pin'])(
      'refuses to save a payload key that looks sensitive: %s',
      (key) => {
        expect(() => saveResumeState({ returnTo: '/explore', actionType: 'x', payload: { [key]: 'whatever' } })).toThrow();
        expect(peekResumeState()).toBeNull();
      },
    );

    it('refuses to save a payload that exceeds the size bound', () => {
      const huge = { blob: 'x'.repeat(10_000) };
      expect(() => saveResumeState({ returnTo: '/explore', actionType: 'x', payload: huge })).toThrow();
    });
  });

  describe('validation of data read back from storage', () => {
    it('rejects malformed JSON already sitting in storage and clears it', () => {
      window.sessionStorage.setItem('apuriva_authgate_resume', '{not json');
      expect(peekResumeState()).toBeNull();
      expect(window.sessionStorage.getItem('apuriva_authgate_resume')).toBeNull();
    });

    it.each([
      { version: 2, returnTo: '/x', actionType: 'a', payload: {}, savedAt: 1, expiresAt: 2 }, // wrong version
      { version: 1, returnTo: 'not-a-path', actionType: 'a', payload: {}, savedAt: 1, expiresAt: 2 }, // unsafe path
      { version: 1, returnTo: '/x', actionType: '', payload: {}, savedAt: 1, expiresAt: 2 }, // empty actionType
      { version: 1, returnTo: '/x', actionType: 'a', payload: [], savedAt: 1, expiresAt: 2 }, // payload not an object
      { version: 1, returnTo: '/x', actionType: 'a', payload: {}, savedAt: 2, expiresAt: 1 }, // expiresAt before savedAt
      null,
      'a string',
      42,
    ])('treats malformed shape %j as invalid', (bad) => {
      expect(isValidResumeState(bad)).toBe(false);
    });

    it('rejects and clears a value with a tampered/invalid shape sitting in storage', () => {
      window.sessionStorage.setItem('apuriva_authgate_resume', JSON.stringify({ returnTo: '//evil.com' }));
      expect(peekResumeState()).toBeNull();
      expect(window.sessionStorage.getItem('apuriva_authgate_resume')).toBeNull();
    });
  });

  describe('bounded lifetime / expiry', () => {
    it('is resumable immediately after saving', () => {
      saveResumeState({ returnTo: '/explore', actionType: 'browse' });
      expect(peekResumeState()).not.toBeNull();
    });

    it('expires and is discarded once the TTL has elapsed', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      saveResumeState({ returnTo: '/explore', actionType: 'browse' });

      vi.setSystemTime(RESUME_STATE_TTL_MS + 1);
      expect(peekResumeState()).toBeNull();
      // Expired entries are opportunistically cleared, not just hidden.
      expect(window.sessionStorage.getItem('apuriva_authgate_resume')).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('single-use consume + explicit clear', () => {
    it('consumeResumeState returns the state once, then null', () => {
      saveResumeState({ returnTo: '/explore', actionType: 'browse' });
      expect(consumeResumeState()).not.toBeNull();
      expect(consumeResumeState()).toBeNull();
      expect(peekResumeState()).toBeNull();
    });

    it('clearResumeState removes a pending resume without requiring it be read first', () => {
      saveResumeState({ returnTo: '/explore', actionType: 'browse' });
      clearResumeState();
      expect(peekResumeState()).toBeNull();
    });
  });

  describe('storage choice (bounded to the browser session, not durable across restarts)', () => {
    it('uses sessionStorage, not localStorage', () => {
      saveResumeState({ returnTo: '/explore', actionType: 'browse' });
      expect(window.sessionStorage.getItem('apuriva_authgate_resume')).not.toBeNull();
      expect(window.localStorage.getItem('apuriva_authgate_resume')).toBeNull();
    });
  });
});
