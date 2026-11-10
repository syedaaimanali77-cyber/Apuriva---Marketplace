'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Select, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { EarningsLineDto, EarningsSummaryDto, PayoutDetailDto, PayoutDto } from '@/lib/types/payouts';
import {
  apiFetch,
  EARNINGS_POLL_MS,
  formatDate,
  formatMoney,
  LINE_STATE_LABELS,
  PAYOUT_STATUS_LABELS,
} from './earnings-client';
import styles from './earnings.module.css';

interface LoadedEarnings {
  summary: EarningsSummaryDto;
  lines: EarningsLineDto[];
  payouts: PayoutDto[];
  recoveries: PayoutDetailDto['items'];
}

const FIGURES: Array<{ key: keyof EarningsSummaryDto; label: string }> = [
  { key: 'grossAmountMinorUnits', label: 'Gross' },
  { key: 'feeAmountMinorUnits', label: 'Platform fee' },
  { key: 'refundsAmountMinorUnits', label: 'Refunds' },
  { key: 'adjustmentsAmountMinorUnits', label: 'Adjustments' },
  { key: 'netAmountMinorUnits', label: 'Net' },
  { key: 'pendingAmountMinorUnits', label: 'Pending' },
  { key: 'upcomingAmountMinorUnits', label: 'Upcoming' },
  { key: 'paidAmountMinorUnits', label: 'Paid' },
];

/**
 * Spec 024 §5.1 — the provider earnings dashboard (AC-3, AC-5, AC-6).
 *
 * Every figure is rendered exactly as the server computed it; this screen performs no arithmetic.
 * `pending` and `upcoming` are never merged, and nothing is described as paid before its payout has
 * reached `paid` (master spec §132.7). The dashboard's own earnings snapshot belongs to spec 037.
 */
export default function ProviderEarningsPage() {
  const [currency, setCurrency] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<LoadedEarnings | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    const query = currency ? `?currency=${encodeURIComponent(currency)}` : '';
    const summary = await apiFetch<EarningsSummaryDto>(`/api/v1/providers/me/earnings${query}`);
    if (!summary.ok || !summary.data) {
      setLoadError(summary.error?.message ?? 'We could not load your earnings.');
      setStatus('error');
      return;
    }
    const code = summary.data.currencyCode;
    const [lines, payouts] = await Promise.all([
      apiFetch<EarningsLineDto[]>(`/api/v1/providers/me/earnings/lines?currency=${code}&limit=50`),
      apiFetch<PayoutDto[]>('/api/v1/providers/me/payouts?limit=20'),
    ]);
    if (!lines.ok || !payouts.ok) {
      setLoadError(lines.error?.message ?? payouts.error?.message ?? 'We could not load your earnings.');
      setStatus('error');
      return;
    }

    let recoveries: PayoutDetailDto['items'] = [];
    const openBatch = (payouts.data ?? []).find((p) => p.status === 'pending' && p.currencyCode === code);
    if (openBatch && summary.data.balanceAmountMinorUnits < 0) {
      const detail = await apiFetch<PayoutDetailDto>(`/api/v1/providers/me/payouts/${openBatch.id}`);
      recoveries = (detail.data?.items ?? []).filter((item) => item.kind === 'refund_recovery');
    }

    setData({
      summary: summary.data,
      lines: lines.data ?? [],
      payouts: (payouts.data ?? []).filter((p) => p.currencyCode === code),
      recoveries,
    });
    setStatus('ready');
  }, [currency]);

  useEffect(() => {
    void load();
  }, [load]);

  const processing = data?.payouts.some((p) => p.status === 'processing') ?? false;
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void load(), EARNINGS_POLL_MS);
    return () => clearInterval(timer);
  }, [processing, load]);

  const exportStatement = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    const params = new URLSearchParams({ from, to });
    if (data) params.set('currency', data.summary.currencyCode);
    const res = await fetch(`/api/v1/providers/me/earnings/statement?${params.toString()}`, { credentials: 'same-origin' });
    setExporting(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setExportError(body.message ?? 'The statement could not be exported. Please try again.');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `earnings-statement-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [data, from, to]);

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Earnings</h1>
        <Skeleton lines={4} />
        <Skeleton lines={6} />
      </main>
    );
  }

  if (status === 'error' || !data) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Earnings</h1>
        <ErrorState title="We couldn't load your earnings." description={loadError ?? undefined} onRetry={() => void load()} retryLabel="Try again" />
      </main>
    );
  }

  const { summary, lines, payouts, recoveries } = data;
  const isEmpty = summary.availableCurrencyCodes.length === 0 && lines.length === 0 && payouts.length === 0;

  const lineColumns: TableColumn<EarningsLineDto>[] = [
    { key: 'date', header: 'Date', render: (row) => formatDate(row.scheduledAt) },
    {
      key: 'booking',
      header: 'Booking',
      render: (row) => <Link href={`/provider/schedule/bookings/${row.bookingId}`}>View booking</Link>,
    },
    { key: 'gross', header: 'Gross', numeric: true, render: (row) => formatMoney(row.grossAmountMinorUnits, row.currencyCode) },
    { key: 'fee', header: 'Fee', numeric: true, render: (row) => formatMoney(row.feeAmountMinorUnits, row.currencyCode) },
    { key: 'feeReturned', header: 'Fee returned', numeric: true, render: (row) => formatMoney(row.feeReversalAmountMinorUnits, row.currencyCode) },
    { key: 'refund', header: 'Refunded', numeric: true, render: (row) => formatMoney(row.refundedAmountMinorUnits, row.currencyCode) },
    { key: 'net', header: 'Net', numeric: true, render: (row) => formatMoney(row.netAmountMinorUnits, row.currencyCode) },
    { key: 'state', header: 'State', render: (row) => <Badge>{LINE_STATE_LABELS[row.state] ?? row.state}</Badge> },
  ];

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Earnings</h1>
        <div className={styles.controls}>
          {summary.availableCurrencyCodes.length > 1 && (
            <label className={styles.field}>
              Currency
              <Select
                aria-label="Currency"
                value={summary.currencyCode}
                options={summary.availableCurrencyCodes}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setCurrency(event.target.value)}
              />
            </label>
          )}
          <Link href="/provider/earnings/payout-methods">Payout methods</Link>
        </div>
      </header>

      {summary.payoutOnHold && (
        <Alert tone="warning" title="Payout on hold">
          Your payouts are on hold. Please contact support.
        </Alert>
      )}
      {summary.payoutMethodRequired && (
        <Alert tone="info" title="Add a payout method to be paid">
          Payouts can't be sent until you add a payout method.{' '}
          <Link href="/provider/earnings/payout-methods">Add a payout method</Link>
        </Alert>
      )}

      {isEmpty ? (
        <EmptyState
          title="No earnings yet"
          description="Earnings appear here once a completed booking has settled."
          action={<Link href="/provider/schedule">Review my schedule</Link>}
        />
      ) : (
        <>
          <Card>
            <div className={styles.figures}>
              {FIGURES.map(({ key, label }) => (
                <div key={key} className={styles.figure}>
                  <span className={styles.figureLabel}>{label}</span>
                  <span className={styles.figureValue} data-testid={`figure-${key}`}>
                    {formatMoney(summary[key] as number, summary.currencyCode)}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {summary.balanceAmountMinorUnits < 0 && (
            <Alert tone="warning" title="Amount to be recovered">
              Your balance is {formatMoney(summary.balanceAmountMinorUnits, summary.currencyCode)}. Money from refunded bookings will be
              recovered from your future payouts.
              <ul>
                {recoveries.map((item) => (
                  <li key={item.id}>
                    {item.bookingId ? <Link href={`/provider/schedule/bookings/${item.bookingId}`}>Booking</Link> : 'Booking'}:{' '}
                    {formatMoney(item.itemAmountMinorUnits, item.currencyCode)}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          <Card>
            <h2 className={styles.sectionTitle}>Payouts</h2>
            {payouts.length === 0 ? (
              <p className={styles.description}>No payouts yet.</p>
            ) : (
              <div className={styles.list}>
                {payouts.map((payout) => (
                  <div key={payout.id} className={styles.row}>
                    <span>{formatMoney(payout.amountMinorUnits, payout.currencyCode)}</span>
                    <Badge tone={payout.status === 'paid' ? 'success' : payout.status === 'failed' ? 'error' : 'neutral'}>
                      {PAYOUT_STATUS_LABELS[payout.status] ?? payout.status}
                    </Badge>
                    <span className={styles.meta}>
                      {payout.payoutMethodMaskedDetail ?? ''} {payout.paidAt ? `Paid ${formatDate(payout.paidAt)}` : ''}
                    </span>
                    {payout.status === 'failed' && (
                      <Alert tone="error">
                        This payout did not complete, and the money is back in your payable balance. Check or update your{' '}
                        <Link href="/provider/earnings/payout-methods">payout method</Link>. If the problem continues, support has
                        been notified and will help.
                      </Alert>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <h2 className={styles.sectionTitle}>Booking earnings</h2>
            <Table columns={lineColumns} rows={lines} caption="Booking earnings" density="dense" emptyMessage="No booking earnings yet." />
          </Card>
        </>
      )}

      <Card>
        <h2 className={styles.sectionTitle}>Export a statement</h2>
        {exportError && <Alert tone="error">{exportError}</Alert>}
        <div className={styles.controls}>
          <label className={styles.field}>
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className={styles.field}>
            To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <Button variant="secondary" onClick={() => void exportStatement()} disabled={!from || !to || exporting} loading={exporting}>
            Download CSV
          </Button>
        </div>
      </Card>
    </main>
  );
}
