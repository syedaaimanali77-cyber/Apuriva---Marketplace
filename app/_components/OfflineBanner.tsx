'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Alert } from '@/components/Alert';
import { useLocale } from './LocaleProvider';
import { useNetworkStatus } from './useNetworkStatus';

/**
 * Spec 044 §3.3/§3.4 (AC-2, AC-3) — the app-wide offline notice: the design system's `Alert`
 * (`tone="warning"`, which renders `role="status"`) with the existing `errors.NETWORK_ERROR` text, distinct
 * from a screen's own error state. Content already on screen stays visible underneath.
 *
 * When connectivity returns the notice clears and the current route's server components are refreshed
 * once (`router.refresh()`); client-fetched views keep their own retry. Nothing is queued or replayed (D-2).
 * Placed once, in app/layout.tsx.
 */
export function OfflineBanner() {
  const { online } = useNetworkStatus();
  const { t } = useLocale();
  const router = useRouter();
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
    } else if (wasOffline.current) {
      wasOffline.current = false;
      router.refresh();
    }
  }, [online, router]);

  if (online) return null;
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 'var(--z-sticky)', padding: 'var(--space-2) var(--space-4)' }}>
      <Alert tone="warning">{t('errors.NETWORK_ERROR')}</Alert>
    </div>
  );
}
