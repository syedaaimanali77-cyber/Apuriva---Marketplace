'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, FormField, Input, PriceDisplay, Skeleton, Textarea } from '@/components';
import { OfferCountdown } from '@/app/_components/OfferCountdown';
import { RequestMessageThread } from '@/app/_components/RequestMessageThread';
import { formatMinorUnits, parseMajorAmountToMinorUnits } from '@/lib/offers/price-input';
import type { AvailableAction, IncomingRequestDto, ProviderResponse } from '@/lib/types/matching';
import type { OfferMessageDto } from '@/lib/types/negotiation';
import type { OfferDto, VisibleOfferStatus } from '@/lib/types/offers';
import styles from './requests.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
  errors?: { field: string; message: string }[];
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/** Same CSRF-cookie-echo pattern as app/admin/marketplace/catalog/page.tsx. */
function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

function describeError(error: ApiErrorBody | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.errors?.length) return error.errors.map((e) => `${e.field} ${e.message}`).join(' ');
  return error.message ?? fallback;
}

/** Spec 018/019 §5: specific messages for the offer error codes. */
function describeOfferError(error: ApiErrorBody | undefined, fallback: string): string {
  switch (error?.code) {
    case 'LIVE_OFFER_EXISTS':
      return 'You already have an offer waiting on this request.';
    case 'REQUEST_NOT_ACTIONABLE':
      return 'This request is no longer open for offers.';
    case 'OFFER_EXPIRED':
      return 'Your offer expired — you can send a new one.';
    case 'OFFER_SUPERSEDED':
      return 'This offer was already replaced by a newer one.';
    case 'REVISION_UNCHANGED':
      return 'Change at least one term to send a revised offer.';
    case 'REVISION_LIMIT_REACHED':
      return "You've reached the limit of 5 revisions on this request.";
    case 'THREAD_CLOSED':
      return 'This conversation is closed.';
    default:
      return describeError(error, fallback);
  }
}

const RESPONSE_LABEL: Record<ProviderResponse, string> = {
  none: '',
  accepted: 'You accepted this request',
  declined: 'You declined this request',
  offer_sent: 'You sent an offer',
};

const OFFER_STATUS_LABEL: Record<VisibleOfferStatus, string> = {
  sent: 'Offer sent',
  viewed: 'Offer viewed',
  revised: 'Offer revised',
  accepted: 'Offer accepted',
  declined: 'Offer declined',
  expired: 'Offer expired',
  withdrawn: 'Offer withdrawn',
};

/** Spec 019 §3: the most revisions a provider may make on one request (enforced by the server). */
const MAX_REVISIONS = 5;

function isLiveOfferStatus(status: VisibleOfferStatus): boolean {
  return status === 'sent' || status === 'viewed';
}

type PageStatus = 'loading' | 'error' | 'ready';

interface OfferDraft {
  price: string;
  currencyCode: string;
  includedItems: string;
  message: string;
  duration: string;
}

/** Which offer form is open: a fresh offer (spec 018) or a revision of the current offer (spec 019). */
type OfferForm = { requestId: string; mode: 'offer' } | { requestId: string; mode: 'revision'; sourceOfferId: string; revisionNumber: number };

function emptyDraft(request: IncomingRequestDto): OfferDraft {
  // Default to the request budget's currency when it has one (the server requires a match); otherwise
  // the provider states it — no country-specific default (master spec §132.19).
  return { price: '', currencyCode: request.budget?.currencyCode ?? '', includedItems: '', message: '', duration: '' };
}

/**
 * Spec 017 §5 / spec 018 §5 / spec 019 §5, `app/provider/requests` — the provider's incoming-request inbox.
 *
 * Fixed/package/hourly requests keep spec 017's Accept/Decline. Quote/custom requests get a working
 * "Send offer" form (spec 018): each submission sends a fresh `Idempotency-Key`. A live offer shows the
 * display-only countdown and Withdraw; an expired/withdrawn offer shows its status and — when the server
 * reports `send_offer` again — the form (AC-5). Spec 019 adds the request's pre-selection thread (a provider
 * may ask before offering), surfaces a customer's change request, and a "Send revised offer" form
 * pre-filled from the current offer (and the proposed price) that posts a revision — a new offer row with
 * its own server-computed window. Every availability decision comes from the server.
 * Per CLAUDE.md's branding rule, no logo/header of its own.
 */
export default function ProviderRequestsPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [requests, setRequests] = useState<IncomingRequestDto[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [declineTarget, setDeclineTarget] = useState<IncomingRequestDto | null>(null);
  const [offerForm, setOfferForm] = useState<OfferForm | null>(null);
  const [draft, setDraft] = useState<OfferDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [threadOpenFor, setThreadOpenFor] = useState<string | null>(null);
  const [changeRequests, setChangeRequests] = useState<Record<string, OfferMessageDto | undefined>>({});

  const load = useCallback(async () => {
    const res = await apiFetch<IncomingRequestDto[]>('/api/v1/providers/me/requests');
    if (!res.ok) {
      setPageStatus((current) => (current === 'ready' ? current : 'error'));
      setPageError(describeError(res.error, "Couldn't load your requests."));
      return;
    }
    setRequests(res.data!);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Spec 018 §5: no WebSocket layer — refetch while a live offer is displayed, and on focus.
  const anyLiveOffer = requests.some((r) => r.currentOffer && isLiveOfferStatus(r.currentOffer.status));
  useEffect(() => {
    if (!anyLiveOffer) return;
    const handle = setInterval(load, 10_000);
    return () => clearInterval(handle);
  }, [anyLiveOffer, load]);
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  async function respond(requestId: string, action: 'accept' | 'decline') {
    setActionError(null);
    setPendingRequestId(requestId);
    const res = await apiFetch<{ providerResponse: ProviderResponse }>(
      `/api/v1/providers/me/requests/${encodeURIComponent(requestId)}/${action}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() } },
    );
    setPendingRequestId(null);
    if (!res.ok) {
      if (res.error?.code === 'REQUEST_ALREADY_CLAIMED') {
        setActionError('Another provider has already taken this request.');
      } else {
        setActionError(describeError(res.error, `Couldn't ${action} that request.`));
      }
      await load();
      return;
    }
    setRequests((prev) =>
      prev.map((r) => (r.requestId === requestId ? { ...r, providerResponse: res.data!.providerResponse } : r)),
    );
    setAnnouncement(action === 'accept' ? 'Request accepted.' : 'Request declined.');
  }

  function openOfferForm(request: IncomingRequestDto) {
    setFormError(null);
    setOfferForm({ requestId: request.requestId, mode: 'offer' });
    setDraft(emptyDraft(request));
  }

  /** Spec 019: pre-fills from the current offer, and from the customer's proposed price when there is one. */
  async function openRevisionForm(request: IncomingRequestDto) {
    if (!request.currentOffer) return;
    setActionError(null);
    setFormError(null);
    setPendingRequestId(request.requestId);
    const res = await apiFetch<OfferDto>(`/api/v1/offers/${encodeURIComponent(request.currentOffer.offerId)}`);
    setPendingRequestId(null);
    if (!res.ok || !res.data) {
      setActionError(describeOfferError(res.error, "Couldn't load your current offer."));
      return;
    }
    const offer = res.data;
    const changeRequest = changeRequests[request.requestId];
    const proposed = changeRequest && changeRequest.offerId === offer.id ? changeRequest.proposedPrice : null;
    setDraft({
      price: formatMinorUnits(proposed ? proposed.amountMinorUnits : offer.priceAmountMinorUnits),
      currencyCode: offer.currencyCode,
      includedItems: offer.includedItems.join('\n'),
      message: offer.providerMessage ?? '',
      duration: offer.estimatedDurationMinutes ? String(offer.estimatedDurationMinutes) : '',
    });
    setOfferForm({ requestId: request.requestId, mode: 'revision', sourceOfferId: offer.id, revisionNumber: offer.revisionNumber });
  }

  async function submitOffer(request: IncomingRequestDto) {
    if (!draft || !offerForm) return;
    setFormError(null);
    const priceAmountMinorUnits = parseMajorAmountToMinorUnits(draft.price);
    if (priceAmountMinorUnits === null) {
      setFormError('Enter a price greater than zero, with at most two decimal places.');
      return;
    }
    const includedItems = draft.includedItems
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const duration = draft.duration.trim();
    const terms = {
      priceAmountMinorUnits,
      currencyCode: draft.currencyCode.trim().toUpperCase(),
      includedItems,
      providerMessage: draft.message,
      estimatedDurationMinutes: duration === '' ? null : Number(duration),
    };
    const revision = offerForm.mode === 'revision';

    setPendingRequestId(request.requestId);
    const res = await apiFetch<OfferDto>(
      revision ? `/api/v1/offers/${encodeURIComponent(offerForm.sourceOfferId)}/revisions` : '/api/v1/offers',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': readCsrfCookie(),
          // One fresh key per form submission (spec 018 §5 / spec 019 §5).
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(revision ? terms : { requestId: request.requestId, ...terms }),
      },
    );
    setPendingRequestId(null);
    if (!res.ok) {
      setFormError(describeOfferError(res.error, revision ? "Couldn't send that revised offer." : "Couldn't send that offer."));
      await load();
      return;
    }
    setOfferForm(null);
    setDraft(null);
    setAnnouncement(
      revision ? 'Revised offer sent. The customer has 2 minutes to respond.' : 'Offer sent. The customer has 2 minutes to respond.',
    );
    await load();
  }

  async function withdraw(request: IncomingRequestDto) {
    if (!request.currentOffer) return;
    setActionError(null);
    setPendingRequestId(request.requestId);
    const res = await apiFetch<OfferDto>(`/api/v1/offers/${encodeURIComponent(request.currentOffer.offerId)}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() },
    });
    setPendingRequestId(null);
    if (!res.ok) {
      setActionError(describeOfferError(res.error, "Couldn't withdraw that offer."));
    } else {
      setAnnouncement('Offer withdrawn.');
    }
    await load();
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Requests</h1>
        <Card>
          <Skeleton lines={5} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Requests</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Requests</h1>
      </div>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      {actionError ? (
        <Alert tone="error" title="Something went wrong" onDismiss={() => setActionError(null)}>
          {actionError}
        </Alert>
      ) : null}

      {requests.length === 0 ? (
        <EmptyState
          title="No new requests right now"
          description="Requests are matched to providers based on service area, availability and verification."
          suggestions={['Broaden your service areas', 'Check your availability schedule is up to date']}
          action={
            <Link href="/provider/schedule">
              <Button variant="primary">Review my schedule</Button>
            </Link>
          }
        />
      ) : (
        <div className={styles.list}>
          {requests.map((request) => {
            const responded = request.providerResponse !== 'none';
            const isPending = pendingRequestId === request.requestId;
            const offer = request.currentOffer;
            const offerLive = offer !== null && isLiveOfferStatus(offer.status);
            const action: AvailableAction = request.availableAction;
            const form = offerForm?.requestId === request.requestId && draft !== null ? offerForm : null;
            const formOpen = form !== null;
            const revisionForm = form?.mode === 'revision' ? form : null;
            const changeRequest = changeRequests[request.requestId];
            const showChangeRequest = offer !== null && changeRequest !== undefined && changeRequest.offerId === offer.offerId;
            const canRevise =
              offer !== null &&
              request.providerResponse === 'offer_sent' &&
              (offer.status === 'sent' || offer.status === 'viewed' || offer.status === 'expired');
            const threadOpen = threadOpenFor === request.requestId;
            const threadCanSend = request.providerResponse !== 'declined' && offer?.status !== 'declined';
            return (
              <Card key={request.requestId} elevation="flat" className={styles.requestCard}>
                <div className={styles.requestHeader}>
                  <div className={styles.requestMeta}>
                    <span className={styles.serviceName}>{request.serviceName}</span>
                    {request.urgency === 'urgent' ? (
                      <Badge tone="warning" size="sm">
                        Urgent
                      </Badge>
                    ) : null}
                  </div>
                  {offer ? (
                    <Badge tone={offer.status === 'accepted' ? 'success' : 'neutral'} size="sm">
                      {OFFER_STATUS_LABEL[offer.status]}
                    </Badge>
                  ) : responded ? (
                    <Badge tone={request.providerResponse === 'accepted' ? 'success' : 'neutral'} size="sm">
                      {RESPONSE_LABEL[request.providerResponse]}
                    </Badge>
                  ) : null}
                </div>

                <p className={styles.requestDetail}>{request.description}</p>

                <div className={styles.requestFacts}>
                  <span>{request.approxAreaLabel}</span>
                  {request.approxDistanceKm !== null ? <span>~{request.approxDistanceKm} km away</span> : null}
                  {request.budget ? (
                    <span>
                      {'amountMinorUnits' in request.budget
                        ? `Budget: ${(request.budget.amountMinorUnits / 100).toFixed(2)} ${request.budget.currencyCode}`
                        : `Budget: ${(request.budget.minAmountMinorUnits / 100).toFixed(2)}–${(request.budget.maxAmountMinorUnits / 100).toFixed(2)} ${request.budget.currencyCode}`}
                    </span>
                  ) : null}
                  {request.preferredAt ? <span>Preferred: {new Date(request.preferredAt).toLocaleString()}</span> : null}
                </div>

                {showChangeRequest ? (
                  <Alert tone="info" title="The customer asked for a change">
                    {changeRequest.body}
                    {changeRequest.proposedPrice ? (
                      <>
                        {' '}
                        Proposed price:{' '}
                        <PriceDisplay
                          priceDisplay={{
                            type: 'exact',
                            amountMinorUnits: changeRequest.proposedPrice.amountMinorUnits,
                            currencyCode: changeRequest.proposedPrice.currencyCode,
                          }}
                        />
                      </>
                    ) : null}
                  </Alert>
                ) : null}

                {offer && offerLive ? (
                  <div className={styles.requestActions}>
                    <OfferCountdown expiresAt={offer.expiresAt} serverNow={offer.serverNow} onElapsed={load} />
                    <Button variant="ghost" loading={isPending} onClick={() => withdraw(request)}>
                      Withdraw offer
                    </Button>
                  </div>
                ) : null}

                {formOpen ? (
                  <form
                    className={styles.requestCard}
                    aria-label={revisionForm ? `Send a revised offer for ${request.serviceName}` : `Send an offer for ${request.serviceName}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitOffer(request);
                    }}
                  >
                    {formError ? (
                      <Alert tone={revisionForm ? 'error' : 'error'} title={revisionForm ? 'Revised offer not sent' : 'Offer not sent'}>
                        {formError}
                      </Alert>
                    ) : null}
                    {revisionForm ? (
                      <p className={styles.requestDetail}>
                        Revisions used: {revisionForm.revisionNumber} of {MAX_REVISIONS}. A revised offer replaces your current one and
                        starts a new 2-minute window.
                      </p>
                    ) : null}
                    <FormField label="Price" htmlFor={`offer-price-${request.requestId}`} help="e.g. 3200 or 3200.50">
                      <Input
                        id={`offer-price-${request.requestId}`}
                        inputMode="decimal"
                        value={draft!.price}
                        onChange={(e) => setDraft({ ...draft!, price: e.target.value })}
                      />
                    </FormField>
                    <FormField label="Currency" htmlFor={`offer-currency-${request.requestId}`} help="3-letter code, e.g. PKR">
                      <Input
                        id={`offer-currency-${request.requestId}`}
                        maxLength={3}
                        value={draft!.currencyCode}
                        disabled={revisionForm !== null}
                        onChange={(e) => setDraft({ ...draft!, currencyCode: e.target.value })}
                      />
                    </FormField>
                    <FormField label="What's included" htmlFor={`offer-items-${request.requestId}`} help="One item per line" optional>
                      <Textarea
                        id={`offer-items-${request.requestId}`}
                        value={draft!.includedItems}
                        onChange={(e) => setDraft({ ...draft!, includedItems: e.target.value })}
                      />
                    </FormField>
                    <FormField label="Message to the customer" htmlFor={`offer-message-${request.requestId}`} optional>
                      <Textarea
                        id={`offer-message-${request.requestId}`}
                        maxLength={1000}
                        value={draft!.message}
                        onChange={(e) => setDraft({ ...draft!, message: e.target.value })}
                      />
                    </FormField>
                    <FormField label="Estimated duration (minutes)" htmlFor={`offer-duration-${request.requestId}`} optional>
                      <Input
                        id={`offer-duration-${request.requestId}`}
                        type="number"
                        min={1}
                        max={1440}
                        value={draft!.duration}
                        onChange={(e) => setDraft({ ...draft!, duration: e.target.value })}
                      />
                    </FormField>
                    <div className={styles.requestActions}>
                      <Button type="submit" variant="primary" loading={isPending}>
                        {revisionForm ? 'Send revised offer' : 'Send offer'}
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setOfferForm(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}

                {!formOpen && (action === 'accept' || action === 'send_offer') ? (
                  <div className={styles.requestActions}>
                    {action === 'accept' ? (
                      <Button variant="primary" loading={isPending} onClick={() => respond(request.requestId, 'accept')}>
                        Accept
                      </Button>
                    ) : (
                      <Button variant="primary" onClick={() => openOfferForm(request)}>
                        {offer ? 'Send a new offer' : 'Send offer'}
                      </Button>
                    )}
                    {!responded ? (
                      <Button variant="ghost" onClick={() => setDeclineTarget(request)}>
                        Decline
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                <div className={styles.requestActions}>
                  {!formOpen && canRevise ? (
                    <Button variant="secondary" loading={isPending} onClick={() => openRevisionForm(request)}>
                      Send revised offer
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => setThreadOpenFor(threadOpen ? null : request.requestId)}>
                    {threadOpen ? 'Hide messages' : 'Messages'}
                  </Button>
                </div>

                {threadOpen ? (
                  <RequestMessageThread
                    listUrl={`/api/v1/providers/me/requests/${encodeURIComponent(request.requestId)}/messages`}
                    postUrl={`/api/v1/providers/me/requests/${encodeURIComponent(request.requestId)}/messages`}
                    viewerRole="provider"
                    counterpartyLabel="Customer"
                    canSend={threadCanSend}
                    closedMessage="This conversation is closed."
                    onMessages={(messages) => {
                      const latest = [...messages].reverse().find((message) => message.kind === 'change_request');
                      setChangeRequests((previous) =>
                        previous[request.requestId]?.id === latest?.id ? previous : { ...previous, [request.requestId]: latest },
                      );
                    }}
                  />
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={declineTarget !== null}
        title="Decline this request?"
        description={
          declineTarget ? `You won't be able to accept "${declineTarget.serviceName}" after declining it.` : undefined
        }
        confirmLabel="Decline"
        cancelLabel="Keep it"
        tone="danger"
        pending={pendingRequestId === declineTarget?.requestId}
        onConfirm={async () => {
          if (!declineTarget) return;
          await respond(declineTarget.requestId, 'decline');
          setDeclineTarget(null);
        }}
        onCancel={() => setDeclineTarget(null)}
      />
    </main>
  );
}
