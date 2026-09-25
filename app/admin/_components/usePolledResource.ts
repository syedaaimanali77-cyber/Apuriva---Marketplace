'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Spec 037 §5 "Live updates — polling" (D-14). No WebSocket layer exists in this repository, so
 * the dashboard polls on the repository's existing 10-second cadence (`BOOKING_POLL_MS`,
 * `EARNINGS_POLL_MS`).
 */
export const ADMIN_DASHBOARD_POLL_MS = 10_000;

export type PolledStatus = 'loading' | 'forbidden' | 'error' | 'ready';

export interface PolledResource<T> {
  status: PolledStatus;
  /** The last successfully loaded value. Kept when a later poll fails. */
  data: T | null;
  /** The first-load error message, shown by the page's `ErrorState`. */
  error: string | null;
  /** True while the latest POLL failed and `data` is the last good value (with its old "as of"). */
  pollFailed: boolean;
  retry: () => void;
}

interface ApiEnvelope {
  message?: string;
}

/**
 * One independently loaded dashboard widget.
 *
 * - `poll: true` refreshes every `ADMIN_DASHBOARD_POLL_MS`; `false` loads once (the configuration
 *   screen, whose values change rarely and elsewhere).
 * - No overlap: a tick is skipped while the previous request is still in flight.
 * - Paused while `document.hidden`, resuming with an immediate refresh when the tab is visible again
 *   (the `visibilitychange` pattern of `BookingConversation`/`RequestMessageThread`).
 * - A failed POLL keeps the last good data and only raises `pollFailed`; the next success clears it.
 * - Everything is cleared on unmount, and no state is set afterwards.
 *
 * `select` maps the JSON envelope to the widget's value; pass a module-level function so the
 * callback identity is stable.
 */
export function usePolledResource<T>(
  url: string,
  select: (json: unknown) => T,
  options: { poll: boolean },
): PolledResource<T> {
  const [state, setState] = useState<Omit<PolledResource<T>, 'retry'>>({
    status: 'loading',
    data: null,
    error: null,
    pollFailed: false,
  });
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const json: unknown = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      if (res.ok) {
        setState({ status: 'ready', data: select(json), error: null, pollFailed: false });
      } else if (res.status === 403) {
        setState({ status: 'forbidden', data: null, error: null, pollFailed: false });
      } else {
        const message = (json as ApiEnvelope).message ?? 'This information could not be loaded.';
        setState((prev) =>
          prev.data !== null ? { ...prev, pollFailed: true } : { status: 'error', data: null, error: message, pollFailed: false },
        );
      }
    } catch {
      if (!mounted.current) return;
      setState((prev) =>
        prev.data !== null
          ? { ...prev, pollFailed: true }
          : { status: 'error', data: null, error: 'This information could not be loaded.', pollFailed: false },
      );
    } finally {
      inFlight.current = false;
    }
  }, [url, select]);

  useEffect(() => {
    mounted.current = true;
    void load();
    if (!options.poll) {
      return () => {
        mounted.current = false;
      };
    }

    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, ADMIN_DASHBOARD_POLL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [load, options.poll]);

  const retry = useCallback(() => {
    setState((prev) => (prev.data !== null ? prev : { status: 'loading', data: null, error: null, pollFailed: false }));
    void load();
  }, [load]);

  return { ...state, retry };
}
