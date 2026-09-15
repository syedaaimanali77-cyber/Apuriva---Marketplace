'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { RefundDto } from '@/lib/types/refunds';
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
  if (res.status === 204) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

/**
 * Spec 022 §5 "Finance Admin" — the refund operations screen.
 *
 * Initiating an override here NEVER refunds anything: with `refunds/override` seeded at risk tier
 * `high`, the server answers `202` with an `AdminAction` awaiting a SECOND, distinct admin. This
 * screen says so explicitly rather than implying the money has moved, and a reason is required
 * before the control is enabled (master spec §68).
 *
 * Approving and rejecting happen on spec 009's existing `/admin/approvals` screen — this spec adds
 * no second approval UI, because a second one would be a second place for four-eyes to go wrong.
 */
export default function AdminRefundsPage() {
  const [refunds, setRefunds] = useState<RefundDto[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [bookingId, setBookingId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('PKR');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const result = await apiFetch<RefundDto[]>('/api/v1/admin/refunds?limit=50');
    if (!result.ok) {
      setLoadError(result.error?.message ?? 'We could not load refunds.');
      setStatus('error');
      return;
    }
    setRefunds(result.data ?? []);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    setPending(true);
    setActionError(null);
    setNotice(null);

    const result = await apiFetch<{ adminActionId: string }>('/api/v1/admin/refunds', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': readCsrfCookie(),
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        bookingId: bookingId.trim(),
        amountMinorUnits: Number(amount),
        currencyCode: currency.trim().toUpperCase(),
        reason: reason.trim(),
      }),
    });

    setPending(false);
    setConfirming(false);

    if (!result.ok) {
      setActionError(result.error?.message ?? 'The override could not be initiated.');
      return;
    }
    setNotice(
      'Override submitted. Nothing has been refunded yet — a second admin must approve it on the Pending approvals screen before any money moves.',
    );
    setBookingId('');
    setAmount('');
    setReason('');
    await load();
  }, [amount, bookingId, currency, load, reason]);

  const columns: TableColumn<RefundDto>[] = [
    { key: 'bookingId', header: 'Booking', render: (row) => <code>{row.bookingId.slice(0, 8)}</code> },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      render: (row) => formatMoney(row.totalAmountMinorUnits, row.totalCurrencyCode),
    },
    { key: 'status', header: 'Status', render: (row) => <Badge>{STATUS_LABELS[row.status] ?? row.status}</Badge> },
    { key: 'source', header: 'Source', render: (row) => (row.isOverride ? 'Admin override' : 'Policy') },
    {
      key: 'reconciliation',
      header: 'Reconciliation',
      render: (row) => (row.reconciliationState === 'reconciled' ? 'Reconciled' : 'Pending'),
    },
    { key: 'reason', header: 'Reason', render: (row) => row.lines.map((line) => line.reason).join('; ') },
  ];

  const canSubmit = bookingId.trim().length > 0 && Number(amount) > 0 && reason.trim().length > 0 && !pending;

  return (
    <main className={styles.page}>
      <header className={styles.sectionHeader}>
        <h1 className={styles.title}>Refunds</h1>
        <p className={styles.sectionDescription}>
          Every manual refund is a high-risk action: a second, different admin must approve it on{' '}
          <Link href="/admin/approvals">Pending approvals</Link> before any money moves.
        </p>
      </header>

      <Card>
        <h2 className={styles.sectionTitle}>Initiate an override</h2>
        {notice && <Alert tone="info">{notice}</Alert>}
        {actionError && (
          <Alert tone="error">{actionError}</Alert>
        )}
        <div className={styles.form}>
          <label className={styles.formField}>
            Booking ID
            <input value={bookingId} onChange={(e) => setBookingId(e.target.value)} />
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
        <Button onClick={() => setConfirming(true)} disabled={!canSubmit}>
          Submit for approval
        </Button>
      </Card>

      {status === 'loading' && <Skeleton lines={4} />}
      {status === 'error' && (
        <ErrorState title="We couldn't load refunds." description={loadError ?? undefined} onRetry={() => void load()} />
      )}
      {status === 'ready' && (
        <Card>
          <h2 className={styles.sectionTitle}>Recent refunds</h2>
          <Table columns={columns} rows={refunds} caption="Refunds" density="dense" emptyMessage="No refunds yet." />
        </Card>
      )}

      {/* Master spec §68/§90 — a financial admin action, bound to its exact parameters. */}
      <ConfirmDialog
        open={confirming}
        title="Submit this refund for approval?"
        description={`This will request a refund of ${formatMoney(Number(amount) || 0, currency.toUpperCase())} on booking ${bookingId}. Reason: ${reason}. Nothing is refunded until a second admin approves it.`}
        confirmLabel="Submit for approval"
        tone="primary"
        pending={pending}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      />
    </main>
  );
}

const STATUS_LABELS: Record<string, string> = {
  requested: 'Requested',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

function formatMoney(amountMinorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amountMinorUnits / 100);
  } catch {
    return `${currencyCode} ${(amountMinorUnits / 100).toFixed(2)}`;
  }
}
