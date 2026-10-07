'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Icon, OfferCard, PriceDisplay, Skeleton, Table } from '@/components';
import { OfferCountdown } from '@/app/_components/OfferCountdown';
import { useLocale, type LocaleContextValue } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatNumber } from '@/lib/i18n/format';
import type { Translator } from '@/lib/i18n/translator-core';
import type { ComparedOfferDto, ComparisonUnavailableReason, OfferComparisonDto, WhyThisProviderReason } from '@/lib/types/negotiation';
import type { OfferDto } from '@/lib/types/offers';
import type { RequestDto } from '@/lib/types/requests';
import { apiFetch, mutateHeaders, type ApiErrorBody } from '../../api-client';
import styles from '../../requests.module.css';
import compare from './compare.module.css';

/** Spec 018 §5 cadence — an open comparison refetches while offers are live. */
export const COMPARISON_REFRESH_INTERVAL_MS = 10_000;

const UNAVAILABLE_COPY: Record<ComparisonUnavailableReason, MessageKey> = {
  fewer_than_two_comparable_offers: 'compare.unavailable.fewer_than_two_comparable_offers',
  request_not_open_for_offers: 'compare.unavailable.request_not_open_for_offers',
  pricing_model_not_offer_based: 'compare.unavailable.pricing_model_not_offer_based',
};

/** Spec 019 §3 "Why this provider" — fixed copy per reason code. The server never sends prose. */
export function reasonCopy(t: Translator, reason: WhyThisProviderReason, hasPreferredTime: boolean): string {
  switch (reason) {
    case 'top_match':
      return t('compare.reason.top_match');
    case 'available_at_requested_time':
      return hasPreferredTime ? t('compare.reason.atRequestedTime') : t('compare.reason.whenRequested');
    case 'nearby':
      return t('compare.reason.nearby');
  }
}

function availabilityCopy(t: Translator, offer: ComparedOfferDto, hasPreferredTime: boolean): string {
  if (offer.availabilityFit === 'exact') return hasPreferredTime ? t('compare.reason.atRequestedTime') : t('compare.reason.whenRequested');
  if (offer.availabilityFit === 'same_day') return t('compare.sameDay');
  return t('compare.notStated');
}

function describeError(
  t: Translator,
  errorText: LocaleContextValue['errorText'],
  error: ApiErrorBody | undefined,
  fallback: string,
): string {
  switch (error?.code) {
    case 'OFFER_SUPERSEDED':
      return t('compare.errors.OFFER_SUPERSEDED');
    case 'OFFER_EXPIRED':
      return t('compare.errors.OFFER_EXPIRED');
    case 'REQUEST_ALREADY_CLAIMED':
      return t('compare.errors.REQUEST_ALREADY_CLAIMED');
    case 'OFFER_NOT_COMPARABLE':
      return t('compare.errors.OFFER_NOT_COMPARABLE');
    default:
      return errorText(error?.code, error?.message, fallback);
  }
}

function money(amountMinorUnits: number, currencyCode: string) {
  return <PriceDisplay priceDisplay={{ type: 'exact', amountMinorUnits, currencyCode }} />;
}

interface AttributeRow {
  key: string;
  label: string;
  [offerId: string]: React.ReactNode;
}

/**
 * Spec 019 §5, `app/requests/[id]/compare` — 2–3 live offers side by side (AC-2, AC-6, AC-10, AC-11).
 *
 * Built only from the Design System: a `Table` on wide screens and stacked `OfferCard`s on narrow ones.
 * Top Match and every reason are icon + text, never colour alone. Nothing here shows a score, weight or
 * rank number — the server never sends one. Accept targets the exact offer row shown (spec 018's accept).
 */
export default function CompareOffersPage() {
  const { locale, t, errorText } = useLocale();
  const params = useParams<{ id: string }>();
  const requestId = String(params?.id ?? '');
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [comparison, setComparison] = useState<OfferComparisonDto | null>(null);
  const [hasPreferredTime, setHasPreferredTime] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingOfferId, setPendingOfferId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiFetch<OfferComparisonDto>(`/api/v1/requests/${encodeURIComponent(requestId)}/offers/compare`);
    if (!result.ok || !result.data) {
      if (result.error?.code === 'OFFER_NOT_COMPARABLE') setAlert(describeError(t, errorText, result.error, ''));
      setStatus((current) => (current === 'ready' ? current : 'error'));
      return;
    }
    setComparison(result.data);
    setStatus('ready');
    const request = await apiFetch<RequestDto>(`/api/v1/requests/${encodeURIComponent(requestId)}`);
    if (request.ok && request.data) setHasPreferredTime(Boolean(request.data.preferredAt));
  }, [requestId, t, errorText]);

  useEffect(() => {
    load();
  }, [load]);

  const available = comparison?.available === true;
  useEffect(() => {
    if (!available) return;
    const handle = setInterval(load, COMPARISON_REFRESH_INTERVAL_MS);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(handle);
      window.removeEventListener('focus', onFocus);
    };
  }, [available, load]);

  async function accept(offer: ComparedOfferDto) {
    setAlert(null);
    setNotice(null);
    setPendingOfferId(offer.offerId);
    const result = await apiFetch<OfferDto>(`/api/v1/offers/${encodeURIComponent(offer.offerId)}/accept`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
    });
    setPendingOfferId(null);
    if (result.ok) setNotice(t('compare.selected'));
    else setAlert(describeError(t, errorText, result.error, t('compare.acceptFailed')));
    await load();
  }

  const backHref = `/requests/${encodeURIComponent(requestId)}`;

  const header = (
    <div className={styles.head}>
      <p className={styles.eyebrow}>
        <Link href={backHref} className={styles.eyebrowLink}>
          {t('compare.back')}
        </Link>
      </p>
      <h1 className={styles.title}>{t('compare.title')}</h1>
    </div>
  );

  if (status === 'loading') {
    return (
      <main className={styles.page} aria-busy="true">
        {header}
        <Card>
          <Skeleton lines={6} />
        </Card>
      </main>
    );
  }

  if (status === 'error' || !comparison) {
    return (
      <main className={styles.page}>
        {header}
        {alert ? <Alert tone="warning">{alert}</Alert> : null}
        <ErrorState description={t('compare.loadFailed')} onRetry={load} />
      </main>
    );
  }

  const feedback = (
    <>
      {alert ? (
        <Alert tone="error" title={t('compare.notAccepted')} onDismiss={() => setAlert(null)}>
          {alert}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" title={t('compare.accepted')} actions={<Link href={backHref}>{t('compare.back')}</Link>}>
          {notice}
        </Alert>
      ) : null}
    </>
  );

  if (!comparison.available) {
    return (
      <main className={styles.page}>
        {header}
        {feedback}
        <EmptyState
          icon="columns-3"
          title={t('compare.nothingTitle')}
          description={t(UNAVAILABLE_COPY[comparison.unavailableReason ?? 'fewer_than_two_comparable_offers'])}
          action={
            <Link href={backHref}>
              <Button variant="primary">{t('compare.back')}</Button>
            </Link>
          }
        />
      </main>
    );
  }

  const offers = comparison.offers;
  const reasonsList = (offer: ComparedOfferDto) =>
    offer.whyThisProvider.length > 0 ? (
      <ul className={compare.reasons}>
        {offer.whyThisProvider.map((reason) => (
          <li key={reason} className={compare.reason}>
            <Icon name={reason === 'top_match' ? 'sparkles' : reason === 'nearby' ? 'map-pin' : 'calendar-check'} size="sm" />
            {reasonCopy(t, reason, hasPreferredTime)}
          </li>
        ))}
      </ul>
    ) : null;
  const acceptButton = (offer: ComparedOfferDto) => (
    <Button
      variant="primary"
      loading={pendingOfferId === offer.offerId}
      disabled={pendingOfferId !== null}
      onClick={() => accept(offer)}
      aria-label={t('compare.acceptLabel', { name: offer.providerBusinessName ?? t('compare.thisProvider') })}
    >
      {t('compare.accept')}
    </Button>
  );
  const priceCell = (offer: ComparedOfferDto) => (
    <span>
      {money(offer.priceAmountMinorUnits, offer.currencyCode)}
      {offer.previousPriceAmountMinorUnits !== null ? (
        <span className={compare.revisedFrom}>
          {t('compare.revisedFrom')} {money(offer.previousPriceAmountMinorUnits, offer.currencyCode)}
        </span>
      ) : null}
    </span>
  );

  const attribute = (key: string, label: string, value: (offer: ComparedOfferDto) => React.ReactNode): AttributeRow => {
    const row: AttributeRow = { key, label };
    for (const offer of offers) row[offer.offerId] = value(offer);
    return row;
  };

  const rows: AttributeRow[] = [
    attribute('price', t('compare.rows.price'), priceCell),
    attribute('time', t('compare.rows.time'), (offer) => (
      <OfferCountdown expiresAt={offer.expiresAt} serverNow={comparison.serverNow} onElapsed={load} />
    )),
    attribute('availability', t('compare.rows.availability'), (offer) => availabilityCopy(t, offer, hasPreferredTime)),
    attribute('distance', t('compare.rows.distance'), (offer) =>
      offer.approxDistanceKm !== null ? t('compare.kmAway', { km: formatNumber(offer.approxDistanceKm, locale) }) : t('compare.notAvailable'),
    ),
    attribute('rating', t('compare.rows.rating'), (offer) =>
      offer.rating
        ? t('compare.ratingValue', { average: formatNumber(offer.rating.average, locale), count: formatNumber(offer.rating.count, locale) })
        : t('compare.notRated'),
    ),
    attribute('badges', t('compare.rows.badges'), (offer) =>
      offer.badges.includes('verified') ? (
        <Badge tone="success" icon="badge-check" size="sm">
          {t('compare.verified')}
        </Badge>
      ) : (
        <span className={compare.muted}>{t('compare.none')}</span>
      ),
    ),
    attribute('included', t('compare.rows.included'), (offer) =>
      offer.includedItems.length > 0 ? (
        <ul className={compare.items}>
          {offer.includedItems.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <span className={compare.muted}>{t('compare.notListed')}</span>
      ),
    ),
    attribute('message', t('compare.rows.message'), (offer) => offer.providerMessage ?? <span className={compare.muted}>{t('compare.noMessage')}</span>),
    attribute('duration', t('compare.rows.duration'), (offer) =>
      offer.estimatedDurationMinutes ? (
        t('compare.about', { minutes: offer.estimatedDurationMinutes })
      ) : (
        <span className={compare.muted}>{t('compare.notStated')}</span>
      ),
    ),
    attribute('why', t('compare.rows.why'), (offer) => reasonsList(offer) ?? <span className={compare.muted}>—</span>),
    attribute('accept', '', acceptButton),
  ];

  const columns = [
    { key: 'label', header: t('compare.offer'), render: (row: AttributeRow) => row.label },
    ...offers.map((offer) => ({
      key: offer.offerId,
      header: (
        <span className={compare.headerCell}>
          <span>{offer.providerBusinessName ?? t('compare.provider')}</span>
          {offer.isTopMatch ? (
            <Badge tone="brand" icon="sparkles" size="sm">
              {t('compare.topMatch')}
            </Badge>
          ) : null}
        </span>
      ),
      render: (row: AttributeRow) => row[offer.offerId],
    })),
  ];

  return (
    <main className={styles.page}>
      {header}
      {feedback}

      <div className={compare.tableView}>
        <Table columns={columns} rows={rows} caption={t('compare.caption', { count: offers.length })} />
      </div>

      <div className={compare.stackView}>
        {offers.map((offer) => (
          <OfferCard
            key={offer.offerId}
            providerName={offer.providerBusinessName ?? t('compare.provider')}
            verified={offer.badges.includes('verified')}
            topMatch={offer.isTopMatch}
            price={priceCell(offer)}
            arrival={availabilityCopy(t, offer, hasPreferredTime)}
            duration={offer.estimatedDurationMinutes ? t('compare.about', { minutes: offer.estimatedDurationMinutes }) : undefined}
            includes={offer.includedItems}
            message={offer.providerMessage ?? undefined}
            actions={
              <>
                <OfferCountdown expiresAt={offer.expiresAt} serverNow={comparison.serverNow} onElapsed={load} />
                {offer.approxDistanceKm !== null ? (
                  <span className={compare.muted}>{t('compare.kmAway', { km: formatNumber(offer.approxDistanceKm, locale) })}</span>
                ) : null}
                {reasonsList(offer)}
                {acceptButton(offer)}
              </>
            }
          />
        ))}
      </div>
    </main>
  );
}
