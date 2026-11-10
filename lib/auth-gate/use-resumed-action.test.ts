// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { peekResumeState, saveResumeState } from './resume-state';
import { useResumedAction } from './use-resumed-action';

describe('useResumedAction (spec 007 AC-3)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('returns null when there is no pending resume state', () => {
    const { result } = renderHook(() => useResumedAction('save-provider'));
    expect(result.current).toBeNull();
  });

  it('returns and consumes the payload for a matching actionType', async () => {
    saveResumeState({ returnTo: '/explore/providers/123', actionType: 'save-provider', payload: { providerId: 'p1' } });

    const { result } = renderHook(() => useResumedAction<{ providerId: string }>('save-provider'));

    await waitFor(() => expect(result.current).toEqual({ providerId: 'p1' }));
    // Single-use: the underlying resume state is gone once consumed.
    expect(peekResumeState()).toBeNull();
  });

  it('leaves a pending resume state untouched when actionType does not match', () => {
    saveResumeState({ returnTo: '/explore/providers/123', actionType: 'send-message', payload: { threadId: 't1' } });

    const { result } = renderHook(() => useResumedAction('save-provider'));

    expect(result.current).toBeNull();
    // Not consumed — still there for whichever page actually owns "send-message".
    expect(peekResumeState()?.actionType).toBe('send-message');
  });
});
