'use client';

import { useEffect, useState } from 'react';
import { clearResumeState, peekResumeState } from './resume-state';

/**
 * Spec 007 AC-3/§4 — for the page named as `returnTo` to call on mount, reading back (and
 * consuming) the payload `useAuthGate` saved before redirecting the guest to authenticate. Only
 * consumes a resume state whose `actionType` matches, so an unrelated pending resume (e.g. the
 * guest navigated away before finishing) is left untouched for whichever page it actually
 * belongs to. Returns `null` until there's a matching, valid, unexpired resume to replay.
 */
export function useResumedAction<T = Record<string, unknown>>(actionType: string): T | null {
  const [payload, setPayload] = useState<T | null>(null);

  useEffect(() => {
    const pending = peekResumeState();
    if (pending && pending.actionType === actionType) {
      clearResumeState();
      setPayload(pending.payload as T);
    }
    // Only ever runs the check once per mount for a given actionType — resuming is single-use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionType]);

  return payload;
}
