'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, ConfirmDialog } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { SessionDto } from '@/lib/types/auth';
import { useLocale } from './LocaleProvider';

/**
 * Spec 045 §5 (X-4, AC-5) — "Reset demo" on `/account`, rendered only for a demo user (`UserDto.isDemo`, X-7).
 * Confirms first (spec 008's `ConfirmDialog`), then calls D2. On success the server has already replaced the
 * session cookies with the new set's persona. A new session starts in customer mode (spec 006 §4), so a provider
 * persona is switched back to provider mode — exactly as the /demo entry does — before landing. On failure nothing
 * was written and the current session is still valid, so the visitor simply stays where they are.
 */
export function DemoResetAction({ provider }: { provider: boolean }) {
  const { t } = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function reset() {
    setPending(true);
    setFailed(false);
    const result = await apiFetch<SessionDto>('/api/v1/demo/reset', { method: 'POST', headers: mutateHeaders(), body: '{}' });
    if (!result.ok) {
      setPending(false);
      setOpen(false);
      setFailed(true);
      return;
    }
    if (provider) {
      await apiFetch('/api/v1/users/me/active-mode', { method: 'PATCH', headers: mutateHeaders(), body: JSON.stringify({ mode: 'provider' }) });
    }
    router.push(provider ? '/provider/dashboard' : '/');
    router.refresh();
  }

  return (
    <section aria-labelledby="demo-reset-heading" style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <h2 id="demo-reset-heading" style={{ margin: 0, fontSize: 'var(--text-lg)', color: 'var(--text-heading)' }}>
        {t('demo.reset.title')}
      </h2>
      <p style={{ margin: 0, color: 'var(--text-body)' }}>{t('demo.reset.description')}</p>
      {failed ? <Alert tone="error">{t('demo.reset.error')}</Alert> : null}
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)} disabled={pending}>
          {t('demo.reset.button')}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        tone="primary"
        title={t('demo.reset.confirmTitle')}
        description={t('demo.reset.confirmDescription')}
        confirmLabel={t('demo.reset.button')}
        pending={pending}
        onConfirm={() => void reset()}
        onCancel={() => setOpen(false)}
      />
    </section>
  );
}
