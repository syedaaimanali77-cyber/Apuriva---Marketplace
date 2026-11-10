'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, EmptyState, ErrorState } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { SessionDto } from '@/lib/types/auth';
import type { DemoPersona } from '@/lib/types/demo';
import { AuthShell } from '../_components/AuthShell';
import styles from '../auth.module.css';

/** The two refusals that mean "this environment has no demo" (§3.6) rather than a failure worth retrying. */
const UNAVAILABLE_CODES = new Set(['DEMO_NOT_AVAILABLE_IN_PRODUCTION', 'DEMO_MODE_DISABLED']);

/** Where each persona lands (§5 "Success"). */
const LANDING: Record<DemoPersona, string> = { customer: '/', provider: '/provider/dashboard' };

type EntryState = { kind: 'idle' } | { kind: 'loading'; persona: DemoPersona } | { kind: 'error'; persona: DemoPersona } | { kind: 'unavailable' };

/**
 * Spec 045 §5 — "Try as Customer" / "Try as Provider". One click calls D1; there is no signup and no admin
 * persona (D-2). A new session starts in customer mode (spec 006 §4), so the provider persona switches to
 * provider mode through spec 006's existing `PATCH /users/me/active-mode` before landing on its dashboard.
 */
export function DemoEntry({ available }: { available: boolean }) {
  const { t } = useLocale();
  const router = useRouter();
  const [state, setState] = useState<EntryState>(available ? { kind: 'idle' } : { kind: 'unavailable' });

  async function start(persona: DemoPersona) {
    setState({ kind: 'loading', persona });
    const login = await apiFetch<SessionDto>('/api/v1/demo/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona }),
    });
    if (!login.ok) {
      setState(UNAVAILABLE_CODES.has(login.error?.code ?? '') ? { kind: 'unavailable' } : { kind: 'error', persona });
      return;
    }
    if (persona === 'provider') {
      const switched = await apiFetch('/api/v1/users/me/active-mode', {
        method: 'PATCH',
        headers: mutateHeaders(),
        body: JSON.stringify({ mode: 'provider' }),
      });
      if (!switched.ok) {
        setState({ kind: 'error', persona });
        return;
      }
    }
    router.push(LANDING[persona]);
    router.refresh();
  }

  const loading = state.kind === 'loading';

  return (
    <AuthShell
      footer={
        <Link href="/login" className={styles.footerLink}>
          {t('demo.entry.logIn')}
        </Link>
      }
    >
      {state.kind === 'unavailable' ? (
        <EmptyState icon="lock" title={t('demo.entry.unavailableTitle')} description={t('demo.entry.unavailableDescription')} />
      ) : state.kind === 'error' ? (
        <ErrorState description={t('demo.entry.error')} onRetry={() => void start(state.persona)} />
      ) : (
        <div className={styles.form} aria-busy={loading}>
          <div>
            <h1 className={styles.title}>{t('demo.entry.title')}</h1>
            <p className={styles.subtitle}>{t('demo.entry.description')}</p>
          </div>

          <div className={styles.form}>
            <Button variant="primary" size="lg" fullWidth iconLeft="user" loading={loading && state.persona === 'customer'} disabled={loading} onClick={() => void start('customer')}>
              {t('demo.entry.tryCustomer')}
            </Button>
            <p className={styles.subtitle}>{t('demo.entry.tryCustomerHint')}</p>
            <Button variant="secondary" size="lg" fullWidth iconLeft="briefcase" loading={loading && state.persona === 'provider'} disabled={loading} onClick={() => void start('provider')}>
              {t('demo.entry.tryProvider')}
            </Button>
            <p className={styles.subtitle}>{t('demo.entry.tryProviderHint')}</p>
          </div>

          <p role="status" aria-live="polite" className={styles.subtitle}>
            {loading ? t('demo.entry.loading') : ''}
          </p>
          <p className={styles.subtitle}>{t('demo.entry.adminNote')}</p>
        </div>
      )}
    </AuthShell>
  );
}
