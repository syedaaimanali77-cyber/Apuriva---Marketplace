'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { AdminPayoutDto, EarningsAdjustmentDto } from '@/lib/types/payouts';
import styles from '../../admin.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

function mutation(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie(), 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  };
}

type Confirming = { kind: 'retry'; payout: AdminPayoutDto } | { kind: 'adjustment' } | null;

/**
 * Spec 024 §5.3 — the Finance Admin payout screen.
 *
 * Retrying a payout and adjusting earnings are both high-risk: submitting here NEVER moves money. The
 * server answers with an AdminAction awaiting a SECOND, distinct admin, who decides on spec 009's
 * existing Pending approvals screen. Only an approved action can then be executed from here.
 * An escalated payout offers no mark-paid or mark-failed control — the payout rail stays authoritative.
 */
export default function AdminPayoutsPage() {
  const [payouts, setPayouts] = useState<AdminPayoutDto[]>([]);
  const [adjustments, setAdjustments] = useState<EarningsAdjustmentDto[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [pending, setPending] = useState(false);

  const [retryReason, setRetryReason] = useState('');
  const [retryActionId, setRetryActionId] = useState('');
  const [providerProfileId, setProviderProfileId] = useState('');
  const [kind, setKind] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('PKR');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const [payoutResult, adjustmentResult] = await Promise.all([
      apiFetch<AdminPayoutDto[]>('/api/v1/admin/payouts?limit=50'),
      apiFetch<EarningsAdjustmentDto[]>('/api/v1/admin/earnings-adjustments?limit=50'),
    ]);
    if (!payoutResult.ok || !adjustmentResult.ok) {
      setLoadError(payoutResult.error?.message ?? adjustmentResult.error?.message ?? 'We could not load payouts.');
      setStatus('error');
      return;
    }
    setPayouts(payoutResult.data ?? []);
    setAdjustments(adjustmentResult.data ?? []);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitRetry = useCallback(
    async (payout: AdminPayoutDto) => {
      setPending(true);
      setActionError(null);
      setNotice(null);
      const body = retryActionId.trim() ? { adminActionId: retryActionId.trim() } : { reason: retryReason.trim() };
      const result = await apiFetch(`/api/v1/admin/payouts/${payout.id}/retry`, mutation(body));
      setPending(false);
      setConfirming(null);
      if (!result.ok) {
        setActionError(result.error?.message ?? 'The retry could not be submitted.');
        return;
      }
      setNotice(
        retryActionId.trim()
          ? 'The approved retry was executed. The payout will be sent on the next payout run.'
          : 'Retry submitted. Nothing is sent until a second admin approves it on the Pending approvals screen.',
      );
      setRetryReason('');
      setRetryActionId('');
      await load();
    },
    [load, retryActionId, retryReason],
  );

  const submitAdjustment = useCallback(async () => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    const result = await apiFetch(
      '/api/v1/admin/earnings-adjustments',
      mutation({ providerProfileId: providerProfileId.trim(), kind, amountMinorUnits: Number(amount), currencyCode: currency.trim().toUpperCase(), reason: reason.trim() }),
    );
    setPending(false);
    setConfirming(null);
    if (!result.ok) {
      setActionError(result.error?.message ?? 'The adjustment could not be submitted.');
      return;
    }
    setNotice('Adjustment submitted. It changes no earnings until a second admin approves it and it is executed.');
    setAmount('');
    setReason('');
    await load();
  }, [amount, currency, kind, load, providerProfileId, reason]);

  const executeAdjustment = useCallback(
    async (adjustment: EarningsAdjustmentDto) => {
      setActionError(null);
      setNotice(null);
      const result = await apiFetch('/api/v1/admin/earnings-adjustments', mutation({ adminActionId: adjustment.adminActionId }));
      if (!result.ok) {
        setActionError(result.error?.message ?? 'The adjustment could not be executed.');
        return;
      }
      setNotice('The approved adjustment was applied.');
      await load();
    },
    [load],
  );

  const payoutColumns: TableColumn<AdminPayoutDto>[] = [
    { key: 'provider', header: 'Provider', render: (row) => <code>{row.providerProfileId.slice(0, 8)}</code> },
    { key: 'amount', header: 'Amount', numeric: true, render: (row) => formatMoney(row.amountMinorUnits, row.currencyCode) },
    { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'failed' ? 'error' : 'neutral'}>{STATUS_LABELS[row.status] ?? row.status}</Badge> },
    { key: 'attempts', header: 'Attempts', numeric: true, render: (row) => row.attemptCount },
    { key: 'method', header: 'Method', render: (row) => row.payoutMethodMaskedDetail ?? '—' },
    { key: 'failure', header: 'Failure', render: (row) => row.failureCode ?? '—' },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) =>
        row.status === 'failed' ? (
          <Button size="sm" variant="secondary" onClick={() => setConfirming({ kind: 'retry', payout: row })}>
            Retry…
          </Button>
        ) : null,
    },
  ];

  const adjustmentColumns: TableColumn<EarningsAdjustmentDto>[] = [
    { key: 'provider', header: 'Provider', render: (row) => <code>{(row.providerProfileId ?? '').slice(0, 8)}</code> },
    { key: 'amount', header: 'Amount', numeric: true, render: (row) => formatMoney(row.adjustmentAmountMinorUnits, row.currencyCode) },
    { key: 'reason', header: 'Reason', render: (row) => row.reason },
    { key: 'state', header: 'State', render: (row) => <Badge tone={row.appliedAt ? 'success' : 'warning'}>{row.appliedAt ? 'Applied' : 'Awaiting approval / execution'}</Badge> },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) =>
        row.appliedAt ? null : (
          <Button size="sm" variant="secondary" onClick={() => void executeAdjustment(row)}>
            Execute if approved
          </Button>
        ),
    },
  ];

  const canSubmitAdjustment = providerProfileId.trim().length > 0 && Number(amount) > 0 && reason.trim().length > 0 && !pending;
  const retryReady = confirming?.kind === 'retry' && (retryActionId.trim().length > 0 || retryReason.trim().length > 0);

  return (
    <main className={styles.page}>
      <header className={styles.sectionHeader}>
        <h1 className={styles.title}>Payouts</h1>
        <p className={styles.sectionDescription}>
          Retries and earnings adjustments are high-risk: a second, different admin must approve them on{' '}
          <Link href="/admin/approvals">Pending approvals</Link> before anything changes.
        </p>
      </header>

      {notice && <Alert tone="info">{notice}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}

      {status === 'loading' && <Skeleton lines={4} />}
      {status === 'error' && <ErrorState title="We couldn't load payouts." description={loadError ?? undefined} onRetry={() => void load()} />}
      {status === 'ready' && (
        <>
          <Card>
            <h2 className={styles.sectionTitle}>Payouts</h2>
            <Table columns={payoutColumns} rows={payouts} caption="Payouts" density="dense" emptyMessage="No payouts yet." />
          </Card>

          <Card>
            <h2 className={styles.sectionTitle}>Request an earnings adjustment</h2>
            <div className={styles.form}>
              <label className={styles.formField}>
                Provider profile ID
                <input value={providerProfileId} onChange={(e) => setProviderProfileId(e.target.value)} />
              </label>
              <label className={styles.formField}>
                Kind
                <select value={kind} onChange={(e) => setKind(e.target.value as 'credit' | 'debit')}>
                  <option value="credit">Credit</option>
                  <option value="debit">Debit</option>
                </select>
              </label>
              <label className={styles.formField}>
                Amount (minor units)
                <input value={amount} inputMode="numeric" onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className={styles.formField}>
                Currency
                <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
              </label>
              <label className={styles.formField}>
                Reason (required)
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            </div>
            <Button onClick={() => setConfirming({ kind: 'adjustment' })} disabled={!canSubmitAdjustment}>
              Submit for approval
            </Button>
          </Card>

          <Card>
            <h2 className={styles.sectionTitle}>Earnings adjustments</h2>
            <Table columns={adjustmentColumns} rows={adjustments} caption="Earnings adjustments" density="dense" emptyMessage="No adjustments yet." />
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirming?.kind === 'retry'}
        title="Retry this failed payout?"
        description={
          confirming?.kind === 'retry' ? (
            <div className={styles.form}>
              <p>
                {formatMoney(confirming.payout.amountMinorUnits, confirming.payout.currencyCode)} to provider{' '}
                {confirming.payout.providerProfileId.slice(0, 8)}. Enter a reason to request approval, or an approved action ID to execute.
              </p>
              <label className={styles.formField}>
                Reason
                <input value={retryReason} onChange={(e) => setRetryReason(e.target.value)} />
              </label>
              <label className={styles.formField}>
                Approved action ID (to execute)
                <input value={retryActionId} onChange={(e) => setRetryActionId(e.target.value)} />
              </label>
            </div>
          ) : undefined
        }
        confirmLabel={retryActionId.trim() ? 'Execute retry' : 'Submit for approval'}
        tone="primary"
        pending={pending || !retryReady}
        onConfirm={() => (confirming?.kind === 'retry' ? void submitRetry(confirming.payout) : undefined)}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming?.kind === 'adjustment'}
        title="Submit this adjustment for approval?"
        description={`A ${kind} of ${formatMoney(Number(amount) || 0, currency.toUpperCase())} for provider ${providerProfileId}. Reason: ${reason}. Nothing changes until a second admin approves it.`}
        confirmLabel="Submit for approval"
        tone="primary"
        pending={pending}
        onConfirm={() => void submitAdjustment()}
        onCancel={() => setConfirming(null)}
      />
    </main>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Accruing',
  eligible: 'Ready to send',
  processing: 'In progress',
  paid: 'Paid',
  failed: 'Failed',
};

function formatMoney(amountMinorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amountMinorUnits / 100);
  } catch {
    return `${currencyCode} ${(amountMinorUnits / 100).toFixed(2)}`;
  }
}
