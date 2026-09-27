'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DirectionalIcon,
  ErrorState,
  Icon,
  PriceDisplay,
  RequestStatusTimeline,
  Skeleton,
} from '@/components';
import { UrgencyEmergencyNotice } from '@/app/_components/UrgencyEmergencyNotice';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDate, formatDateTime } from '@/lib/i18n/format';
import type { CancelPreviewDto, RequestDto, RequestStatus } from '@/lib/types/requests';
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

/** Spec 042 X-12: the same steps, translated for display (matching stays on the server's English step). */
const PROGRESSION_KEYS: MessageKey[] = [
  'requestDetail.step.submitted',
  'requestDetail.step.matching',
  'requestDetail.step.offers_open',
  'requestDetail.step.provider_selected',
  'requestDetail.step.payment',
  'requestDetail.step.booking_created',
];

/** The customer-facing step for a status (spec 015's `CUSTOMER_FACING_STEP`), in the reader's locale. */
function stepKey(status: RequestStatus): MessageKey {
  return `requestDetail.step.${status}`;
}

/**
 * Spec 015 §5, `/requests/{id}` — the live status view and cancellation. Master spec §38: the
 * consequence is fetched from `cancel-preview` and shown *before* the destructive action; this UI
 * never asserts a consequence the server did not return. Per CLAUDE.md's branding rule, no logo.
 */
export default function RequestStatusPage() {
  const { locale, t, errorText } = useLocale();
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
      setError(errorText(result.error?.code, result.error?.message, t('requestDetail.loadFailed')));
      setStatus('error');
      return;
    }
    setRequest(result.data ?? null);
    setStatus('ready');
  }, [errorText, requestId, t]);

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
      setCancelError(errorText(result.error?.code, result.error?.message, t('requestDetail.previewFailed')));
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
      setCancelError(errorText(result.error?.code, result.error?.message, t('requestDetail.cancelFailed')));
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
            {t('requestDetail.requests')}
          </Link>
          <DirectionalIcon name="chevron-right" size="xs" />
          <span>{request.serviceName}</span>
        </span>
        <h1 className={styles.title}>{request.serviceName}</h1>
        <p className={styles.lede}>
          {t('requestDetail.sent', { date: formatDate(request.createdAt, locale) })} ·{' '}
          {request.offerCount > 0
            ? t(request.offerCount === 1 ? 'requestDetail.offersSoFarOne' : 'requestDetail.offersSoFarMany', { count: request.offerCount })
            : t('requestDetail.noOffers')}
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
          <h2 className={styles.sectionTitle}>{t('requestDetail.progress')}</h2>
          <Badge tone={request.status === 'cancelled' ? 'neutral' : 'brand'} icon={null}>
            {t(stepKey(request.status))}
          </Badge>
        </div>

        {terminal ? (
          <p className={styles.sectionHint}>
            {t('requestDetail.terminal', { step: t(stepKey(request.status)).toLowerCase() })}
          </p>
        ) : (
          <RequestStatusTimeline
            steps={PROGRESSION_KEYS.map((key) => ({ label: t(key) }))}
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
        <h2 className={styles.sectionTitle}>{t('requestDetail.whatYouAsked')}</h2>
        <p className={styles.detailValue}>{request.description}</p>

        <div className={styles.detailGrid}>
          {Object.entries(request.fieldValues).map(([key, value]) => (
            <div key={key} className={styles.detail}>
              <span className={styles.detailLabel}>{key}</span>
              <p className={styles.detailValue}>{typeof value === 'boolean' ? (value ? t('requestDetail.yes') : t('requestDetail.no')) : String(value)}</p>
            </div>
          ))}

          <div className={styles.detail}>
            <span className={styles.detailLabel}>{t('requestDetail.urgency')}</span>
            <p className={styles.detailValue}>{request.urgency === 'urgent' ? t('requestDetail.urgent') : t('requestDetail.normal')}</p>
            {/* Spec 030 AC-6 — shown where urgency is DISPLAYED too, not only where it is chosen:
                someone rereading an urgent request is as likely to be waiting for help that is not
                coming. */}
            {request.urgency === 'urgent' ? <UrgencyEmergencyNotice /> : null}
          </div>

          {request.preferredAt ? (
            <div className={styles.detail}>
              <span className={styles.detailLabel}>{t('requestDetail.preferredTime')}</span>
              <p className={styles.detailValue}>{formatDateTime(request.preferredAt, locale)}</p>
            </div>
          ) : null}

          {request.budget ? (
            <div className={styles.detail}>
              <span className={styles.detailLabel}>{t('requestDetail.budget')}</span>
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
            {t('requestDetail.cancelRequest')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={dialogOpen}
        title={t('requestDetail.cancelTitle')}
        description={preview?.consequence ?? t('requestDetail.cancelDefault')}
        confirmLabel={t('requestDetail.cancelRequest')}
        cancelLabel={t('requestDetail.keepIt')}
        pending={cancelling}
        onConfirm={confirmCancel}
        onCancel={() => setDialogOpen(false)}
      />
    </main>
  );
}
