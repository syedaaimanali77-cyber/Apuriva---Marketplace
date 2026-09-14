'use client';

import { useEffect, useRef, useState } from 'react';
import { OfferTimer } from '@/components';
import { countdownSecondsRemaining, OFFER_WINDOW_MS } from '@/lib/offers/timer';
import styles from './offer-countdown.module.css';

export interface OfferCountdownProps {
  /** Authoritative, server-computed. */
  expiresAt: string;
  /** The database clock at the moment the offer was fetched. A new value restarts the countdown. */
  serverNow: string;
  /** Called once when the cosmetic countdown reaches 0 — the parent refetches authoritative state. */
  onElapsed?: () => void;
  size?: 'sm' | 'md';
}

/**
 * Spec 018 §5 — a DISPLAY-ONLY countdown (master spec §32: "the browser timer is cosmetic").
 *
 * Remaining time = `expiresAt − serverNow` at fetch, minus elapsed time measured with the browser's
 * monotonic `performance.now()` — so a wrong device clock can neither lengthen nor shorten it. It never
 * enables, disables or decides anything: at 0 it only asks its parent to refetch and render whatever
 * the server returns. The per-second value is hidden from assistive tech (no per-second announcement);
 * a static "expires at" text is exposed instead, and only reaching 0 is announced.
 */
export function OfferCountdown({ expiresAt, serverNow, onElapsed, size = 'sm' }: OfferCountdownProps) {
  const fetchedAt = useRef(0);
  const firedFor = useRef<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    fetchedAt.current = performance.now();
    setElapsedMs(0);
    const handle = setInterval(() => setElapsedMs(performance.now() - fetchedAt.current), 1000);
    return () => clearInterval(handle);
  }, [expiresAt, serverNow]);

  const seconds = countdownSecondsRemaining(expiresAt, serverNow, elapsedMs);

  useEffect(() => {
    const key = `${expiresAt}|${serverNow}`;
    if (seconds === 0 && firedFor.current !== key) {
      firedFor.current = key;
      onElapsed?.();
    }
  }, [seconds, expiresAt, serverNow, onElapsed]);

  return (
    <div className={styles.countdown} data-testid="offer-countdown" data-seconds-remaining={seconds}>
      <div aria-hidden="true">
        <OfferTimer secondsRemaining={seconds} totalSeconds={OFFER_WINDOW_MS / 1000} size={size} />
      </div>
      <span className={styles.visuallyHidden}>Offer window ends at {new Date(expiresAt).toLocaleTimeString()}</span>
      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {seconds === 0 ? 'Offer time is up — checking the latest status.' : ''}
      </span>
    </div>
  );
}
