'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ErrorState, OfferCard, PriceDisplay, Skeleton } from '@/components';
import { OfferCountdown } from '@/app/_components/OfferCountdown';
import type { OfferDto, VisibleOfferStatus } from '@/lib/types/offers';
import type { RequestStatus } from '@/lib/types/requests';
import { apiFetch, mutateHeaders, type ApiErrorBody } from '../api-client';
import styles from '../requests.module.css';

/** Spec 018 §5: while any live offer is shown, refetch this often (no WebSocket layer exists). */
export const OFFER_REFRESH_INTERVAL_MS = 10_000;

const TERMINAL_LABEL: Record<Exclude<VisibleOfferStatus, 'sent' | 'viewed'>, string> = {
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
  revised: 'Revised',
};

function isLive(offer: OfferDto): boolean {
  return offer.status === 'sent' || offer.status === 'viewed';
}

/** Spec 018 §5 error copy — specific messages, never a generic failure. */
function describeOfferError(error: ApiErrorBody | undefined, fallback: string): string {
  switch (error?.code) {
    case 'OFFER_EXPIRED':
      return 'This offer expired — the provider can send a new one.';
    case 'REQUEST_ALREADY_CLAIMED':
      return "You've already selected a provider for this request.";
    case 'OFFER_ALREADY_DECIDED':
      return error.message;
    default:
      return error?.message ?? fallback;
  }
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
}

export interface OffersPanelProps {
  requestId: string;
  requestStatus: RequestStatus;
  requestCreatedAt: string;
  /** The request's own status may have moved (e.g. `offers_open -> provider_selected`). */
  onRequestChanged: () => void;
}

/**
 * Spec 018 §5 — the customer's offers on their own request (`GET /api/v1/requests/{id}/offers`).
 *
 * Every action is decided by the server. Accept/Decline are shown for offers the SERVER reports as live
 * and never enabled or disabled by the countdown; when a countdown reaches 0 the list is refetched. After
 * an accept this panel creates no booking — booking is spec 020's next step.
 */
export function OffersPanel({ requestId, requestStatus, requestCreatedAt, onRequestChanged }: OffersPanelProps) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [offers, setOffers] = useState<OfferDto[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingOfferId, setPendingOfferId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiFetch<OfferDto[]>(`/api/v1/requests/${encodeURIComponent(requestId)}/offers`);
    if (!result.ok) {
      setStatus((current) => (current === 'ready' ? current : 'error'));
      return;
    }
    // Architecture §6.1: replace local state entirely with the authoritative state.
    setOffers(result.data ?? []);
    setStatus('ready');
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  const anyLive = offers.some(isLive);

  useEffect(() => {
    if (!anyLive) return;
    const handle = setInterval(load, OFFER_REFRESH_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [anyLive, load]);

  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  async function accept(offer: OfferDto) {
    setAlert(null);
    setNotice(null);
    setPendingOfferId(offer.id);
    const result = await apiFetch<OfferDto>(`/api/v1/offers/${encodeURIComponent(offer.id)}/accept`, {
      method: 'POST',
      // One key per accept attempt (spec 018 §3 idempotency).
      headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
    });
    setPendingOfferId(null);
    if (!result.ok) {
      setAlert(describeOfferError(result.error, "Couldn't accept this offer."));
    } else {
      setNotice('Provider selected — booking is the next step.');
      onRequestChanged();
    }
    await load();
  }

  async function decline(offer: OfferDto) {
    setAlert(null);
    setNotice(null);
    setPendingOfferId(offer.id);
    const result = await apiFetch<OfferDto>(`/api/v1/offers/${encodeURIComponent(offer.id)}/decline`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    setPendingOfferId(null);
    if (!result.ok) setAlert(describeOfferError(result.error, "Couldn't decline this offer."));
    await load();
  }

  if (status === 'loading') {
    return (
      <section className={styles.section} aria-busy="true">
        <h2 className={styles.sectionTitle}>Offers</h2>
        <Card>
          <Skeleton lines={3} />
        </Card>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Offers</h2>
        <ErrorState description="Couldn't load offers for this request." onRetry={load} />
      </section>
    );
  }

  const canDecide = requestStatus === 'offers_open';

  return (
    <section className={styles.section} aria-labelledby="offers-heading">
      <h2 id="offers-heading" className={styles.sectionTitle}>
        Offers
      </h2>

      {alert ? (
        <Alert tone="error" title="Offer not updated" onDismiss={() => setAlert(null)}>
          {alert}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" title="Offer accepted" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

      {offers.length === 0 ? (
        <Card>
          <p className={styles.sectionHint}>
            Waiting for offers — your request was sent {minutesSince(requestCreatedAt)} min ago.
          </p>
        </Card>
      ) : (
        offers.map((offer) => {
          const live = isLive(offer);
          const pending = pendingOfferId === offer.id;
          return (
            <OfferCard
              key={offer.id}
              providerName={offer.providerBusinessName ?? 'Provider'}
              price={<PriceDisplay priceDisplay={{ type: 'exact', amountMinorUnits: offer.priceAmountMinorUnits, currencyCode: offer.currencyCode }} />}
              duration={offer.estimatedDurationMinutes ? `About ${offer.estimatedDurationMinutes} min` : undefined}
              includes={offer.includedItems}
              message={offer.providerMessage ?? undefined}
              expired={offer.status === 'expired'}
              actions={
                live ? (
                  <>
                    <OfferCountdown expiresAt={offer.expiresAt} serverNow={offer.serverNow} onElapsed={load} />
                    {canDecide ? (
                      <>
                        <Button variant="primary" loading={pending} disabled={pendingOfferId !== null} onClick={() => accept(offer)}>
                          Accept
                        </Button>
                        <Button variant="secondary" disabled={pendingOfferId !== null} onClick={() => decline(offer)}>
                          Decline
                        </Button>
                      </>
                    ) : null}
                  </>
                ) : offer.status !== 'expired' ? (
                  <Badge tone={offer.status === 'accepted' ? 'success' : 'neutral'}>{TERMINAL_LABEL[offer.status as keyof typeof TERMINAL_LABEL]}</Badge>
                ) : undefined
              }
            />
          );
        })
      )}
    </section>
  );
}
