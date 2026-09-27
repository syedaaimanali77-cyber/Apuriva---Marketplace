'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, ErrorState, FormField, Input, OfferCard, PriceDisplay, Skeleton, Textarea } from '@/components';
import { OfferCountdown } from '@/app/_components/OfferCountdown';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { translateApiErrorWith, type Translator } from '@/lib/i18n/translator';
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

const TERMINAL_LABEL: Record<Exclude<VisibleOfferStatus, 'sent' | 'viewed'>, MessageKey> = {
  accepted: 'offers.terminal.accepted',
  declined: 'offers.terminal.declined',
  expired: 'offers.terminal.expired',
  withdrawn: 'offers.terminal.withdrawn',
  revised: 'offers.terminal.revised',
};

function isLive(offer: OfferDto): boolean {
  return offer.status === 'sent' || offer.status === 'viewed';
}

/** Spec 018/019 §5 error copy — specific messages, never a generic failure (spec 042: in the reader's locale). */
function describeOfferError(t: Translator, error: ApiErrorBody | undefined, fallback: string): string {
  switch (error?.code) {
    case 'OFFER_EXPIRED':
      return t('offers.errors.OFFER_EXPIRED');
    case 'REQUEST_ALREADY_CLAIMED':
      return t('offers.errors.REQUEST_ALREADY_CLAIMED');
    case 'OFFER_ALREADY_DECIDED':
      return error.message;
    case 'OFFER_SUPERSEDED':
      return t('offers.errors.OFFER_SUPERSEDED');
    case 'CHANGE_ALREADY_REQUESTED':
      return t('offers.errors.CHANGE_ALREADY_REQUESTED');
    case 'THREAD_CLOSED':
      return t('offers.errors.THREAD_CLOSED');
    default:
      if (error?.errors?.length) return error.errors.map((e) => `${e.field} ${e.message}`).join(' ');
      return translateApiErrorWith(t, error?.code, error?.message, fallback);
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
  const { t } = useLocale();
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
      setAlert(describeOfferError(t, result.error, t('offers.acceptFailed')));
    } else {
      setNotice({ title: t('offers.acceptedTitle'), text: t('offers.acceptedText') });
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
    if (!result.ok) setAlert(describeOfferError(t, result.error, t('offers.declineFailed')));
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
      setChangeError(t('offers.changeNoteRequired'));
      return;
    }
    let proposedPriceAmountMinorUnits: number | null = null;
    if (changePrice.trim() !== '') {
      proposedPriceAmountMinorUnits = parseMajorAmountToMinorUnits(changePrice);
      if (proposedPriceAmountMinorUnits === null) {
        setChangeError(t('offers.changePriceInvalid'));
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
      setChangeError(describeOfferError(t, result.error, t('offers.changeFailed')));
      await load();
      return;
    }
    setChangeFormFor(null);
    setNotice({ title: t('offers.changedTitle'), text: t('offers.changedText') });
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
        <h2 className={styles.sectionTitle}>{t('offers.title')}</h2>
        <Card>
          <Skeleton lines={3} />
        </Card>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t('offers.title')}</h2>
        <ErrorState description={t('offers.loadFailed')} onRetry={load} />
      </section>
    );
  }

  const canDecide = requestStatus === 'offers_open';
  // Superseded rows are shown through their chain's head, never as separately actionable cards.
  const shown = offers.filter((offer) => offer.status !== 'revised');

  return (
    <section className={styles.section} aria-labelledby="offers-heading">
      <h2 id="offers-heading" className={styles.sectionTitle}>
        {t('offers.title')}
      </h2>

      {alert ? (
        <Alert tone="error" title={t('offers.notUpdated')} onDismiss={() => setAlert(null)}>
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
              {t('offers.compare')}
            </Button>
          </Link>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <Card>
          <p className={styles.sectionHint}>
            {t('offers.waiting', { minutes: minutesSince(requestCreatedAt) })}
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
              providerName={offer.providerBusinessName ?? t('offers.provider')}
              price={
                <span className={negotiation.priceStack}>
                  {money(offer.priceAmountMinorUnits, offer.currencyCode)}
                  {offer.previousPriceAmountMinorUnits !== null ? (
                    <span className={negotiation.revisedFrom}>
                      {t('offers.revisedFrom')} {money(offer.previousPriceAmountMinorUnits, offer.currencyCode)}
                    </span>
                  ) : null}
                </span>
              }
              duration={offer.estimatedDurationMinutes ? t('offers.about', { minutes: offer.estimatedDurationMinutes }) : undefined}
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
                            {t('offers.accept')}
                          </Button>
                          <Button variant="secondary" disabled={pendingOfferId !== null} onClick={() => decline(offer)}>
                            {t('offers.decline')}
                          </Button>
                        </>
                      ) : null}
                    </>
                  ) : offer.status !== 'expired' ? (
                    <Badge tone={offer.status === 'accepted' ? 'success' : 'neutral'}>
                      {t(TERMINAL_LABEL[offer.status as keyof typeof TERMINAL_LABEL])}
                    </Badge>
                  ) : null}

                  {/* Spec 020 §5: the booking step this panel hands off to. Shown only for the
                      accepted offer, and only while the request has not already produced a booking. */}
                  {offer.status === 'accepted' && requestStatus === 'provider_selected' ? (
                    <ConfirmBookingPanel offerId={offer.id} />
                  ) : null}

                  {canRequestChange && !changeOpen ? (
                    <Button variant="ghost" disabled={pendingOfferId !== null} onClick={() => openChangeForm(offer)}>
                      {t('offers.requestChange')}
                    </Button>
                  ) : null}
                  {offer.revisionNumber > 0 ? (
                    <Button variant="ghost" onClick={() => toggleHistory(offer)}>
                      {historyFor === offer.id ? t('offers.hideHistory') : t('offers.history')}
                    </Button>
                  ) : null}

                  {historyFor === offer.id ? (
                    <ol className={negotiation.historyList} aria-label={t('offers.history')}>
                      {history.map((revision) => (
                        <li key={revision.id}>
                          {t('offers.revision', { number: revision.revisionNumber })} {money(revision.previousPrice.amountMinorUnits, revision.previousPrice.currencyCode)}{' '}
                          → {money(revision.newPrice.amountMinorUnits, revision.newPrice.currencyCode)}
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  {changeOpen ? (
                    <form
                      className={negotiation.changeForm}
                      aria-label={t('offers.changeFormLabel', { name: offer.providerBusinessName ?? t('offers.theProvider') })}
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitChange(offer);
                      }}
                    >
                      {changeError ? (
                        <Alert tone="error" title={t('offers.changeNotRequested')}>
                          {changeError}
                        </Alert>
                      ) : null}
                      <FormField label={t('offers.whatChange')} htmlFor={`change-note-${offer.id}`}>
                        <Textarea
                          id={`change-note-${offer.id}`}
                          maxLength={500}
                          value={changeNote}
                          onChange={(event) => setChangeNote(event.target.value)}
                        />
                      </FormField>
                      <FormField label={t('offers.proposedPrice', { currency: offer.currencyCode })} htmlFor={`change-price-${offer.id}`} optional>
                        <Input
                          id={`change-price-${offer.id}`}
                          inputMode="decimal"
                          value={changePrice}
                          onChange={(event) => setChangePrice(event.target.value)}
                        />
                      </FormField>
                      <div className={negotiation.inlineActions}>
                        <Button type="submit" variant="primary" loading={pending}>
                          {t('offers.sendChange')}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setChangeFormFor(null)}>
                          {t('offers.cancel')}
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
