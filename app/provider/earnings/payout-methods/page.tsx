'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Skeleton } from '@/components';
import type { PayoutMethodDto } from '@/lib/types/payouts';
import { apiFetch, readCsrfCookie, requestStepUpToken, type ApiResult } from '../earnings-client';
import styles from '../earnings.module.css';

type PendingAction = { kind: 'default' | 'remove'; method: PayoutMethodDto } | null;

/**
 * Spec 024 §5.2 — payout methods (AC-4, AC-10, AC-11).
 *
 * Only the rail-supplied mask and institution label are ever shown; full detail is never rendered,
 * because the server never had it. Every mutation obtains a fresh `manage_payout_method` step-up
 * token immediately before submitting, and re-prompts once on `403 STEP_UP_REQUIRED`.
 */
export default function PayoutMethodsPage() {
  const [methods, setMethods] = useState<PayoutMethodDto[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await apiFetch<PayoutMethodDto[]>('/api/v1/providers/me/payout-methods');
    if (!result.ok) {
      setLoadError(result.error?.message ?? 'We could not load your payout methods.');
      setStatus('error');
      return;
    }
    setMethods(result.data ?? []);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(async (url: string, method: string, body?: unknown, idempotencyKey?: string): Promise<ApiResult<PayoutMethodDto>> => {
    const send = async () => {
      const token = await requestStepUpToken();
      const headers: Record<string, string> = { 'x-csrf-token': readCsrfCookie(), 'x-step-up-token': token ?? '' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      return apiFetch<PayoutMethodDto>(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    const first = await send();
    if (!first.ok && first.error?.code === 'STEP_UP_REQUIRED') return send();
    return first;
  }, []);

  const addMethod = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    const result = await mutate('/api/v1/providers/me/payout-methods', 'POST', { setupToken: setupToken.trim() }, crypto.randomUUID());
    setBusy(false);
    if (!result.ok) {
      setActionError(result.error?.message ?? 'The payout method could not be added.');
      return;
    }
    setSetupToken('');
    await load();
  }, [load, mutate, setupToken]);

  const confirmAction = useCallback(async () => {
    if (!pendingAction) return;
    setBusy(true);
    setActionError(null);
    const url = `/api/v1/providers/me/payout-methods/${pendingAction.method.id}`;
    const result =
      pendingAction.kind === 'default' ? await mutate(url, 'PATCH', { isDefault: true }) : await mutate(url, 'DELETE');
    setBusy(false);
    setPendingAction(null);
    if (!result.ok) {
      setActionError(result.error?.message ?? 'That change could not be saved.');
      return;
    }
    await load();
  }, [load, mutate, pendingAction]);

  const live = methods.filter((method) => !method.removedAt);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Payout methods</h1>
        <Link href="/provider/earnings">Back to earnings</Link>
      </header>

      {actionError && <Alert tone="error">{actionError}</Alert>}

      <Card>
        <h2 className={styles.sectionTitle}>Add a payout method</h2>
        <p className={styles.description}>
          Your bank or wallet details are entered with our payout provider, never on this page. Paste the setup code the payout
          provider gives you. We store only a masked reference.
        </p>
        <div className={styles.controls}>
          <label className={styles.field}>
            Setup code
            <input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} autoComplete="off" />
          </label>
          <Button onClick={() => void addMethod()} disabled={setupToken.trim().length === 0 || busy} loading={busy}>
            Add payout method
          </Button>
        </div>
      </Card>

      {status === 'loading' && <Skeleton lines={3} />}
      {status === 'error' && (
        <ErrorState title="We couldn't load your payout methods." description={loadError ?? undefined} onRetry={() => void load()} />
      )}
      {status === 'ready' && live.length === 0 && (
        <EmptyState title="No payout methods yet" description="Add a payout method so your earnings can be paid out." />
      )}
      {status === 'ready' && live.length > 0 && (
        <Card>
          <div className={styles.list}>
            {live.map((method) => (
              <div key={method.id} className={styles.row}>
                <span>
                  {method.institutionLabel} {method.maskedDetail}
                </span>
                <span className={styles.meta}>
                  {method.type === 'bank' ? 'Bank' : 'Mobile wallet'} · {method.payoutCurrencyCode}
                  {method.isDefault && <Badge tone="success">Default</Badge>}
                  {method.verificationState !== 'verified' && <Badge tone="warning">Not verified</Badge>}
                </span>
                <span className={styles.meta}>
                  {!method.isDefault && (
                    <Button size="sm" variant="secondary" onClick={() => setPendingAction({ kind: 'default', method })}>
                      Make default
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setPendingAction({ kind: 'remove', method })}>
                    Remove
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.kind === 'remove' ? 'Remove this payout method?' : 'Make this your default payout method?'}
        description={
          pendingAction
            ? pendingAction.kind === 'remove'
              ? `${pendingAction.method.institutionLabel} ${pendingAction.method.maskedDetail} will no longer be used for payouts.`
              : `Future payouts in ${pendingAction.method.payoutCurrencyCode} will go to ${pendingAction.method.institutionLabel} ${pendingAction.method.maskedDetail}.`
            : undefined
        }
        confirmLabel={pendingAction?.kind === 'remove' ? 'Remove' : 'Make default'}
        tone={pendingAction?.kind === 'remove' ? 'danger' : 'primary'}
        pending={busy}
        onConfirm={() => void confirmAction()}
        onCancel={() => setPendingAction(null)}
      />
    </main>
  );
}
