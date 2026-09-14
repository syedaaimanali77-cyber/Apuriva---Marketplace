'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Icon,
  PriceDisplay,
  RequestStatusTimeline,
  Skeleton,
} from '@/components';
import type { CancelPreviewDto, RequestDto } from '@/lib/types/requests';
import { isCancellable } from '@/lib/types/requests';
import { apiFetch, mutateHeaders } from '../api-client';
import styles from '../requests.module.css';
import { OffersPanel } from './OffersPanel';
import { RequestThreadsPanel } from './MessageThread';

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * AC-5: exactly master spec §37's customer progression. The steps are the customer-facing labels,
 * never internal matching mechanics — the server tells us which step the request is on
 * (`customerFacingStep`), and this view only renders it.
 */
const PROGRESSION = [
  'Request sent',
  'Providers notified',
  'Offers received',
  'Provider selected',
  'Payment',
  'Booking confirmed',
];

/**
 * Spec 015 §5, `/requests/{id}` — the live status view and cancellation. Master spec §38: the
 * consequence is fetched from `cancel-preview` and shown *before* the destructive action; this UI
 * never asserts a consequence the server did not return. Per CLAUDE.md's branding rule, no logo.
 */
export default function RequestStatusPage() {
  const params = useParams<{ id: string }>();
  const requestId = params.id;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<RequestDto | null>(null);

  const [preview, setPreview] = useState<CancelPreviewDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    const result = await apiFetch<RequestDto>(`/api/v1/requests/${encodeURIComponent(requestId)}`);
    if (!result.ok) {
      setError(result.error?.message ?? "Couldn't load this request.");
      setStatus('error');
      return;
    }
    setRequest(result.data ?? null);
    setStatus('ready');
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Spec 018: re-read the request after an offer decision without unmounting the page. */
  const refreshRequest = useCallback(async () => {
    const result = await apiFetch<RequestDto>(`/api/v1/requests/${encodeURIComponent(requestId)}`);
    if (result.ok && result.data) setRequest(result.data);
  }, [requestId]);

  async function openCancelDialog() {
    setCancelError(null);
    // Master spec §38: always the dry run first — the dialog's consequence text comes from here.
    const result = await apiFetch<CancelPreviewDto>(`/api/v1/requests/${encodeURIComponent(requestId)}/cancel-preview`);
    if (!result.ok) {
      setCancelError(result.error?.message ?? "Couldn't check what cancelling would mean.");
      return;
    }
    setPreview(result.data ?? null);
    setDialogOpen(true);
  }

  async function confirmCancel() {
    if (!request) return;
    setCancelling(true);
    const result = await apiFetch<RequestDto>(`/api/v1/requests/${encodeURIComponent(requestId)}/cancel`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ expectedVersion: request.version }),
    });
    setCancelling(false);
    setDialogOpen(false);

    if (!result.ok) {
      setCancelError(result.error?.message ?? "Couldn't cancel this request.");
      return;
    }
    setRequest(result.data ?? null);
  }

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <div className={styles.head}>
          <Skeleton width="160px" height={12} />
          <Skeleton width="280px" height={28} />
        </div>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (status === 'error' || !request) {
    return (
      <main className={styles.page}>
        <div className={styles.stateCard}>
          <ErrorState description={error ?? undefined} onRetry={load} />
        </div>
      </main>
    );
  }

  const currentIndex = Math.max(0, PROGRESSION.indexOf(request.customerFacingStep));
  const terminal = !isCancellable(request.status) && !PROGRESSION.includes(request.customerFacingStep);

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <span className={styles.eyebrow}>
          <Link href="/requests" className={styles.eyebrowLink}>
            Requests
          </Link>
          <Icon name="chevron-right" size="xs" />
          <span>{request.serviceName}</span>
        </span>
        <h1 className={styles.title}>{request.serviceName}</h1>
        <p className={styles.lede}>
          Sent {new Date(request.createdAt).toLocaleDateString()} ·{' '}
          {request.offerCount > 0
            ? `${request.offerCount} ${request.offerCount === 1 ? 'offer' : 'offers'} so far`
            : 'No offers yet'}
        </p>
      </header>

      {cancelError ? (
        <p className={styles.errorNote} role="alert">
          <Icon name="circle-alert" size="sm" />
          {cancelError}
        </p>
      ) : null}

      <section className={styles.statusCard}>
        <div className={styles.statusHead}>
          <h2 className={styles.sectionTitle}>Progress</h2>
          <Badge tone={request.status === 'cancelled' ? 'neutral' : 'brand'} icon={null}>
            {request.customerFacingStep}
          </Badge>
        </div>

        {terminal ? (
          <p className={styles.sectionHint}>
            This request is {request.customerFacingStep.toLowerCase()}. Nothing further will happen on it.
          </p>
        ) : (
          <RequestStatusTimeline
            steps={PROGRESSION.map((label) => ({ label }))}
            currentIndex={currentIndex}
            orientation="vertical"
          />
        )}
      </section>

      {request.status !== 'draft' ? (
        <OffersPanel
          requestId={request.id}
          requestStatus={request.status}
          requestCreatedAt={request.createdAt}
          onRequestChanged={refreshRequest}
        />
      ) : null}

      {/* Spec 019 §5: pre-selection threads (only providers who offered or asked). */}
      {request.status !== 'draft' ? <RequestThreadsPanel requestId={request.id} /> : null}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>What you asked for</h2>
        <p className={styles.detailValue}>{request.description}</p>

        <div className={styles.detailGrid}>
          {Object.entries(request.fieldValues).map(([key, value]) => (
            <div key={key} className={styles.detail}>
              <span className={styles.detailLabel}>{key}</span>
              <p className={styles.detailValue}>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</p>
            </div>
          ))}

          <div className={styles.detail}>
            <span className={styles.detailLabel}>Urgency</span>
            <p className={styles.detailValue}>{request.urgency === 'urgent' ? 'Urgent' : 'Normal'}</p>
          </div>

          {request.preferredAt ? (
            <div className={styles.detail}>
              <span className={styles.detailLabel}>Preferred time</span>
              <p className={styles.detailValue}>{new Date(request.preferredAt).toLocaleString()}</p>
            </div>
          ) : null}

          {request.budget ? (
            <div className={styles.detail}>
              <span className={styles.detailLabel}>Budget</span>
              <div className={styles.detailValue}>
                {'amountMinorUnits' in request.budget ? (
                  <PriceDisplay
                    priceDisplay={{
                      type: 'exact',
                      amountMinorUnits: request.budget.amountMinorUnits,
                      currencyCode: request.budget.currencyCode,
                    }}
                  />
                ) : (
                  <PriceDisplay
                    priceDisplay={{
                      type: 'starting',
                      amountMinorUnits: request.budget.minAmountMinorUnits,
                      currencyCode: request.budget.currencyCode,
                    }}
                  />
                )}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {isCancellable(request.status) ? (
        <div className={styles.formActions}>
          <Button variant="secondary" onClick={openCancelDialog}>
            Cancel request
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={dialogOpen}
        title="Cancel this request?"
        description={
          preview?.consequence ?? "No fee — you haven't been charged yet. Providers who were notified will be told."
        }
        confirmLabel="Cancel request"
        cancelLabel="Keep it"
        pending={cancelling}
        onConfirm={confirmCancel}
        onCancel={() => setDialogOpen(false)}
      />
    </main>
  );
}
