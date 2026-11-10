'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { peekResumeState } from '@/lib/auth-gate/resume-state';

/**
 * Spec 007 AC-3/§4 — mounted globally (`app/layout.tsx`) alongside `OnboardingOverlay`. Spec 005's
 * login/register pages always redirect to `/` on success (they know nothing about AuthGate, and
 * this spec doesn't modify them); this component is what actually gets the guest the rest of the
 * way back to their in-progress action. On every route change, if there's a pending, unexpired
 * resume state and the guest isn't already on its `returnTo` page, it checks whether the session
 * is now authenticated and — only then — navigates to `returnTo`. It never consumes the resume
 * state itself; reading (and clearing) the payload is `useResumedAction`'s job, once the
 * destination page has actually mounted.
 */
export function AuthGateResumer() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const pending = peekResumeState();
    if (!pending) return;
    if (pathname === pending.returnTo) return;

    let cancelled = false;
    fetch('/api/v1/users/me', { credentials: 'same-origin' })
      .then((res) => {
        if (cancelled || !res.ok) return;
        router.replace(pending.returnTo);
      })
      .catch(() => {
        // Network hiccup — leave the resume state in place; retried on the next navigation,
        // until it expires (RESUME_STATE_TTL_MS).
      });

    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}
