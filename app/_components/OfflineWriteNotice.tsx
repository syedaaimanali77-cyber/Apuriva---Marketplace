'use client';

import { useLocale } from './LocaleProvider';
import { useNetworkStatus } from './useNetworkStatus';

/**
 * Spec 044 §3.5 (AC-3) — the offline notice under a critical write control (request submission, booking
 * confirmation, payment, message send) that is disabled while offline. The control points at it with
 * `aria-describedby`, so the reason it is disabled is announced. Nothing is queued (D-2).
 */
export function OfflineWriteNotice({ id }: { id: string }) {
  const { online } = useNetworkStatus();
  const { t } = useLocale();
  if (online) return null;
  return (
    <p id={id} style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
      {t('errors.NETWORK_ERROR')}
    </p>
  );
}
