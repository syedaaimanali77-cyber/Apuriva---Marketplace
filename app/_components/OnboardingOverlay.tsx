'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components';
import { hasSeenOnboarding, markOnboardingSeen } from '@/lib/onboarding/seen-state';
import styles from './onboarding-overlay.module.css';

/**
 * Spec 007 AC-1/AC-5/§5 — the in-app first-run overlay. Not a separate route (§5, resolved): it
 * renders on top of the existing guest-accessible entry screen. Deliberately not a modal — no
 * `aria-modal`, no focus trap, and the page behind it stays fully interactive — because AC-1
 * requires it to "never block exploration." Dismissing it (Skip or Escape) marks it seen via
 * `lib/onboarding/seen-state` (durable client-side storage) so it never reappears (AC-5).
 *
 * The design system has no `Dialog`/`Overlay` primitive yet (see `components/index.ts`), so —
 * same approach as spec 006's account-menu.module.css — this is a small, self-contained overlay
 * built directly from existing design tokens rather than a new design-system component.
 */
export function OnboardingOverlay() {
  const [visible, setVisible] = useState(false);
  // Button isn't built with forwardRef (same limitation as IconButton, see
  // app/account/_components/AccountMenu.tsx), so initial focus is reached via this wrapping span.
  const dismissButtonWrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!hasSeenOnboarding()) setVisible(true);
  }, []);

  useEffect(() => {
    if (visible) dismissButtonWrapRef.current?.querySelector('button')?.focus();
  }, [visible]);

  function dismiss() {
    markOnboardingSeen();
    setVisible(false);
  }

  useEffect(() => {
    if (!visible) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visible]);

  if (!visible) return null;

  return (
    <div className={styles.wrapper}>
      <div className={styles.card} role="region" aria-label="Welcome">
        <div className={styles.body}>
          <p className={styles.title}>Browse freely — no account needed</p>
          <p className={styles.copy}>
            Explore categories, search, and check out providers and reviews without signing up.
            You'll only be asked to create an account when you're ready to book, message, or pay.
          </p>
        </div>
        <div className={styles.actions}>
          <span ref={dismissButtonWrapRef} style={{ display: 'inline-flex' }}>
            <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Skip introduction">
              Skip
            </Button>
          </span>
          <Button variant="primary" size="sm" onClick={dismiss}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
