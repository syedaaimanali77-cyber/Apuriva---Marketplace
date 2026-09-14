'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Icon, OfferCard, PriceDisplay, Skeleton, Table } from '@/components';
import { OfferCountdown } from '@/app/_components/OfferCountdown';
import type { ComparedOfferDto, ComparisonUnavailableReason, OfferComparisonDto, WhyThisProviderReason } from '@/lib/types/negotiation';
import type { OfferDto } from '@/lib/types/offers';
import type { RequestDto } from '@/lib/types/requests';
import { apiFetch, mutateHeaders, type ApiErrorBody } from '../../api-client';
import styles from '../../requests.module.css';
import compare from './compare.module.css';

/** Spec 018 §5 cadence — an open comparison refetches while offers are live. */
export const COMPARISON_REFRESH_INTERVAL_MS = 10_000;

const UNAVAILABLE_COPY: Record<ComparisonUnavailableReason, string> = {
  fewer_than_two_comparable_offers: 'Comparison needs at least two live offers.',
  request_not_open_for_offers: 'This request is no longer open for offers.',
  pricing_model_not_offer_based: "This service has a set price, so there's nothing to compare.",
};

/** Spec 019 §3 "Why this provider" — fixed copy per reason code. The server never sends prose. */
export function reasonCopy(reason: WhyThisProviderReason, hasPreferredTime: boolean): string {
  switch (reason) {
    case 'top_match':
      return 'Top Match for your request';
    case 'available_at_requested_time':
      return hasPreferredTime ? 'Available at your requested time' : 'Available when you requested';
    case 'nearby':
      return 'Close to your address';
  }
}

function availabilityCopy(offer: ComparedOfferDto, hasPreferredTime: boolean): string {
  if (offer.availabilityFit === 'exact') return hasPreferredTime ? 'Available at your requested time' : 'Available when you requested';
  if (offer.availabilityFit === 'same_day') return 'Available the same day';
  return 'Not stated';
}

function describeError(error: ApiErrorBody | undefined, fallback: string): string {
  switch (error?.code) {
    case 'OFFER_SUPERSEDED':
      return 'This offer was revised — review the new price before accepting.';
    case 'OFFER_EXPIRED':
      return 'This offer expired — the provider can send a new one.';
    case 'REQUEST_ALREADY_CLAIMED':
      return "You've already selected a provider for this request.";
    case 'OFFER_NOT_COMPARABLE':
      return 'One of these offers changed — showing the current offers instead.';
    default:
      return error?.message ?? fallback;
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
      if (result.error?.code === 'OFFER_NOT_COMPARABLE') setAlert(describeError(result.error, ''));
      setStatus((current) => (current === 'ready' ? current : 'error'));
      return;
    }
    setComparison(result.data);
    setStatus('ready');
    const request = await apiFetch<RequestDto>(`/api/v1/requests/${encodeURIComponent(requestId)}`);
    if (request.ok && request.data) setHasPreferredTime(Boolean(request.data.preferredAt));
  }, [requestId]);

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
    if (result.ok) setNotice('Provider selected — booking is the next step.');
    else setAlert(describeError(result.error, "Couldn't accept this offer."));
    await load();
  }

  const backHref = `/requests/${encodeURIComponent(requestId)}`;

  const header = (
    <div className={styles.head}>
      <p className={styles.eyebrow}>
        <Link href={backHref} className={styles.eyebrowLink}>
          Back to request
        </Link>
      </p>
      <h1 className={styles.title}>Compare offers</h1>
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
        <ErrorState description="Couldn't load the comparison." onRetry={load} />
      </main>
    );
  }

  const feedback = (
    <>
      {alert ? (
        <Alert tone="error" title="Offer not accepted" onDismiss={() => setAlert(null)}>
          {alert}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" title="Offer accepted" actions={<Link href={backHref}>Back to request</Link>}>
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
          title="Nothing to compare right now"
          description={UNAVAILABLE_COPY[comparison.unavailableReason ?? 'fewer_than_two_comparable_offers']}
          action={
            <Link href={backHref}>
              <Button variant="primary">Back to request</Button>
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
            {reasonCopy(reason, hasPreferredTime)}
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
      aria-label={`Accept ${offer.providerBusinessName ?? 'this provider'}'s offer`}
    >
      Accept
    </Button>
  );
  const priceCell = (offer: ComparedOfferDto) => (
    <span>
      {money(offer.priceAmountMinorUnits, offer.currencyCode)}
      {offer.previousPriceAmountMinorUnits !== null ? (
        <span className={compare.revisedFrom}>Revised from {money(offer.previousPriceAmountMinorUnits, offer.currencyCode)}</span>
      ) : null}
    </span>
  );

  const attribute = (key: string, label: string, value: (offer: ComparedOfferDto) => React.ReactNode): AttributeRow => {
    const row: AttributeRow = { key, label };
    for (const offer of offers) row[offer.offerId] = value(offer);
    return row;
  };

  const rows: AttributeRow[] = [
    attribute('price', 'Price', priceCell),
    attribute('time', 'Time left', (offer) => (
      <OfferCountdown expiresAt={offer.expiresAt} serverNow={comparison.serverNow} onElapsed={load} />
    )),
    attribute('availability', 'Availability', (offer) => availabilityCopy(offer, hasPreferredTime)),
    attribute('distance', 'Distance', (offer) => (offer.approxDistanceKm !== null ? `~${offer.approxDistanceKm} km away` : 'Not available')),
    attribute('rating', 'Rating', (offer) => (offer.rating ? `${offer.rating.average} (${offer.rating.count})` : 'Not yet rated')),
    attribute('badges', 'Badges', (offer) =>
      offer.badges.includes('verified') ? (
        <Badge tone="success" icon="badge-check" size="sm">
          Verified
        </Badge>
      ) : (
        <span className={compare.muted}>None</span>
      ),
    ),
    attribute('included', "What's included", (offer) =>
      offer.includedItems.length > 0 ? (
        <ul className={compare.items}>
          {offer.includedItems.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <span className={compare.muted}>Not listed</span>
      ),
    ),
    attribute('message', 'Provider message', (offer) => offer.providerMessage ?? <span className={compare.muted}>No message</span>),
    attribute('duration', 'Estimated duration', (offer) =>
      offer.estimatedDurationMinutes ? `About ${offer.estimatedDurationMinutes} min` : <span className={compare.muted}>Not stated</span>,
    ),
    attribute('why', 'Why this provider', (offer) => reasonsList(offer) ?? <span className={compare.muted}>—</span>),
    attribute('accept', '', acceptButton),
  ];

  const columns = [
    { key: 'label', header: 'Offer', render: (row: AttributeRow) => row.label },
    ...offers.map((offer) => ({
      key: offer.offerId,
      header: (
        <span className={compare.headerCell}>
          <span>{offer.providerBusinessName ?? 'Provider'}</span>
          {offer.isTopMatch ? (
            <Badge tone="brand" icon="sparkles" size="sm">
              Top Match
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
        <Table columns={columns} rows={rows} caption={`Comparison of ${offers.length} offers`} />
      </div>

      <div className={compare.stackView}>
        {offers.map((offer) => (
          <OfferCard
            key={offer.offerId}
            providerName={offer.providerBusinessName ?? 'Provider'}
            verified={offer.badges.includes('verified')}
            topMatch={offer.isTopMatch}
            price={priceCell(offer)}
            arrival={availabilityCopy(offer, hasPreferredTime)}
            duration={offer.estimatedDurationMinutes ? `About ${offer.estimatedDurationMinutes} min` : undefined}
            includes={offer.includedItems}
            message={offer.providerMessage ?? undefined}
            actions={
              <>
                <OfferCountdown expiresAt={offer.expiresAt} serverNow={comparison.serverNow} onElapsed={load} />
                {offer.approxDistanceKm !== null ? <span className={compare.muted}>~{offer.approxDistanceKm} km away</span> : null}
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
