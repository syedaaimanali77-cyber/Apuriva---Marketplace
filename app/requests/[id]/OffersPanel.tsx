'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, ErrorState, FormField, Input, OfferCard, PriceDisplay, Skeleton, Textarea } from '@/components';
import { OfferCountdown } from '@/app/_components/OfferCountdown';
import { parseMajorAmountToMinorUnits } from '@/lib/offers/price-input';
import type { OfferComparisonDto, OfferRevisionDto } from '@/lib/types/negotiation';
import type { OfferDto, VisibleOfferStatus } from '@/lib/types/offers';
import type { RequestStatus } from '@/lib/types/requests';
import { apiFetch, mutateHeaders, type ApiErrorBody } from '../api-client';
import { ConfirmBookingPanel } from '@/app/bookings/_components/ConfirmBookingPanel';
import styles from '../requests.module.css';
import negotiation from './negotiation.module.css';

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

/** Spec 018/019 §5 error copy — specific messages, never a generic failure. */
function describeOfferError(error: ApiErrorBody | undefined, fallback: string): string {
  switch (error?.code) {
    case 'OFFER_EXPIRED':
      return 'This offer expired — the provider can send a new one.';
    case 'REQUEST_ALREADY_CLAIMED':
      return "You've already selected a provider for this request.";
    case 'OFFER_ALREADY_DECIDED':
      return error.message;
    case 'OFFER_SUPERSEDED':
      return 'This offer was revised — review the new price before accepting.';
    case 'CHANGE_ALREADY_REQUESTED':
      return "You've already asked for a change on this offer.";
    case 'THREAD_CLOSED':
      return 'This conversation is closed.';
    default:
      if (error?.errors?.length) return error.errors.map((e) => `${e.field} ${e.message}`).join(' ');
      return error?.message ?? fallback;
  }
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
}

function money(amountMinorUnits: number, currencyCode: string) {
  return <PriceDisplay priceDisplay={{ type: 'exact', amountMinorUnits, currencyCode }} />;
}

export interface OffersPanelProps {
  requestId: string;
  requestStatus: RequestStatus;
  requestCreatedAt: string;
  /** The request's own status may have moved (e.g. `offers_open -> provider_selected`). */
  onRequestChanged: () => void;
}

/**
 * Spec 018 §5 / spec 019 §5 — the customer's offers on their own request (`GET /api/v1/requests/{id}/offers`).
 *
 * Every action is decided by the server. Accept/Decline are shown for offers the SERVER reports as live
 * and never enabled or disabled by the countdown. Spec 019: superseded (`revised`) rows collapse into their
 * chain's head, which shows "Revised from …" and an on-demand price history; a head that is live or expired
 * offers **Request change**; **Compare offers** appears only when the comparison endpoint says it is
 * available (it is only asked when at least two live offers are shown). Accept always targets the exact
 * offer row shown. After an accept this panel creates no booking — booking is spec 020's next step.
 */
export function OffersPanel({ requestId, requestStatus, requestCreatedAt, onRequestChanged }: OffersPanelProps) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [offers, setOffers] = useState<OfferDto[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);
  const [pendingOfferId, setPendingOfferId] = useState<string | null>(null);
  const [compareAvailable, setCompareAvailable] = useState(false);
  const [changeFormFor, setChangeFormFor] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [changePrice, setChangePrice] = useState('');
  const [changeError, setChangeError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<OfferRevisionDto[]>([]);

  const load = useCallback(async () => {
    const result = await apiFetch<OfferDto[]>(`/api/v1/requests/${encodeURIComponent(requestId)}/offers`);
    if (!result.ok) {
      setStatus((current) => (current === 'ready' ? current : 'error'));
      return;
    }
    // Architecture §6.1: replace local state entirely with the authoritative state.
    const next = result.data ?? [];
    setOffers(next);
    setStatus('ready');

    // Spec 019 AC-6: the server decides availability; it is only asked when two live offers could exist.
    if (next.filter(isLive).length >= 2) {
      const comparison = await apiFetch<OfferComparisonDto>(`/api/v1/requests/${encodeURIComponent(requestId)}/offers/compare`);
      setCompareAvailable(Boolean(comparison.ok && comparison.data?.available));
    } else {
      setCompareAvailable(false);
    }
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
      setNotice({ title: 'Offer accepted', text: 'Provider selected — booking is the next step.' });
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

  function openChangeForm(offer: OfferDto) {
    setChangeFormFor(offer.id);
    setChangeNote('');
    setChangePrice('');
    setChangeError(null);
  }

  async function submitChange(offer: OfferDto) {
    setChangeError(null);
    const note = changeNote.trim();
    if (note.length === 0) {
      setChangeError('Tell the provider what you would like changed.');
      return;
    }
    let proposedPriceAmountMinorUnits: number | null = null;
    if (changePrice.trim() !== '') {
      proposedPriceAmountMinorUnits = parseMajorAmountToMinorUnits(changePrice);
      if (proposedPriceAmountMinorUnits === null) {
        setChangeError('Enter a price greater than zero, with at most two decimal places.');
        return;
      }
    }
    setPendingOfferId(offer.id);
    const result = await apiFetch(`/api/v1/offers/${encodeURIComponent(offer.id)}/change-requests`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify({ note, proposedPriceAmountMinorUnits }),
    });
    setPendingOfferId(null);
    if (!result.ok) {
      setChangeError(describeOfferError(result.error, "Couldn't send your change request."));
      await load();
      return;
    }
    setChangeFormFor(null);
    setNotice({ title: 'Change requested', text: 'The provider can now send you a revised offer.' });
    await load();
  }

  async function toggleHistory(offer: OfferDto) {
    if (historyFor === offer.id) {
      setHistoryFor(null);
      return;
    }
    const result = await apiFetch<OfferRevisionDto[]>(`/api/v1/offers/${encodeURIComponent(offer.id)}/revisions`);
    setHistory(result.ok ? (result.data ?? []) : []);
    setHistoryFor(offer.id);
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
  // Superseded rows are shown through their chain's head, never as separately actionable cards.
  const shown = offers.filter((offer) => offer.status !== 'revised');

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
        <Alert tone="success" title={notice.title} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      ) : null}

      {compareAvailable && canDecide ? (
        <div className={negotiation.compareBar}>
          <Link href={`/requests/${encodeURIComponent(requestId)}/compare`}>
            <Button variant="secondary" iconLeft="columns-3">
              Compare offers
            </Button>
          </Link>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <Card>
          <p className={styles.sectionHint}>
            Waiting for offers — your request was sent {minutesSince(requestCreatedAt)} min ago.
          </p>
        </Card>
      ) : (
        shown.map((offer) => {
          const live = isLive(offer);
          const pending = pendingOfferId === offer.id;
          const canRequestChange = canDecide && (live || offer.status === 'expired');
          const changeOpen = changeFormFor === offer.id;
          return (
            <OfferCard
              key={offer.id}
              providerName={offer.providerBusinessName ?? 'Provider'}
              price={
                <span className={negotiation.priceStack}>
                  {money(offer.priceAmountMinorUnits, offer.currencyCode)}
                  {offer.previousPriceAmountMinorUnits !== null ? (
                    <span className={negotiation.revisedFrom}>
                      Revised from {money(offer.previousPriceAmountMinorUnits, offer.currencyCode)}
                    </span>
                  ) : null}
                </span>
              }
              duration={offer.estimatedDurationMinutes ? `About ${offer.estimatedDurationMinutes} min` : undefined}
              includes={offer.includedItems}
              message={offer.providerMessage ?? undefined}
              expired={offer.status === 'expired'}
              actions={
                <>
                  {live ? (
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
                    <Badge tone={offer.status === 'accepted' ? 'success' : 'neutral'}>
                      {TERMINAL_LABEL[offer.status as keyof typeof TERMINAL_LABEL]}
                    </Badge>
                  ) : null}

                  {/* Spec 020 §5: the booking step this panel hands off to. Shown only for the
                      accepted offer, and only while the request has not already produced a booking. */}
                  {offer.status === 'accepted' && requestStatus === 'provider_selected' ? (
                    <ConfirmBookingPanel offerId={offer.id} />
                  ) : null}

                  {canRequestChange && !changeOpen ? (
                    <Button variant="ghost" disabled={pendingOfferId !== null} onClick={() => openChangeForm(offer)}>
                      Request change
                    </Button>
                  ) : null}
                  {offer.revisionNumber > 0 ? (
                    <Button variant="ghost" onClick={() => toggleHistory(offer)}>
                      {historyFor === offer.id ? 'Hide price history' : 'Price history'}
                    </Button>
                  ) : null}

                  {historyFor === offer.id ? (
                    <ol className={negotiation.historyList} aria-label="Price history">
                      {history.map((revision) => (
                        <li key={revision.id}>
                          Revision {revision.revisionNumber}: {money(revision.previousPrice.amountMinorUnits, revision.previousPrice.currencyCode)}{' '}
                          → {money(revision.newPrice.amountMinorUnits, revision.newPrice.currencyCode)}
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  {changeOpen ? (
                    <form
                      className={negotiation.changeForm}
                      aria-label={`Request a change from ${offer.providerBusinessName ?? 'the provider'}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitChange(offer);
                      }}
                    >
                      {changeError ? (
                        <Alert tone="error" title="Change not requested">
                          {changeError}
                        </Alert>
                      ) : null}
                      <FormField label="What would you like changed?" htmlFor={`change-note-${offer.id}`}>
                        <Textarea
                          id={`change-note-${offer.id}`}
                          maxLength={500}
                          value={changeNote}
                          onChange={(event) => setChangeNote(event.target.value)}
                        />
                      </FormField>
                      <FormField label={`Proposed price (${offer.currencyCode})`} htmlFor={`change-price-${offer.id}`} optional>
                        <Input
                          id={`change-price-${offer.id}`}
                          inputMode="decimal"
                          value={changePrice}
                          onChange={(event) => setChangePrice(event.target.value)}
                        />
                      </FormField>
                      <div className={negotiation.inlineActions}>
                        <Button type="submit" variant="primary" loading={pending}>
                          Send change request
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setChangeFormFor(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </>
              }
            />
          );
        })
      )}
    </section>
  );
}
