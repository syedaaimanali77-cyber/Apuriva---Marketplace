'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Skeleton } from '@/components';
import type { AvailableAction, IncomingRequestDto, ProviderResponse } from '@/lib/types/matching';
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

const RESPONSE_LABEL: Record<ProviderResponse, string> = {
  none: '',
  accepted: 'You accepted this request',
  declined: 'You declined this request',
  offer_sent: 'You sent an offer',
};

/** AC-5: fixed/package/hourly -> Accept, quote/custom -> Send Offer (a state only — spec 018 owns
 * the endpoint), always Decline while actionable. */
function actionLabel(action: AvailableAction): string {
  switch (action) {
    case 'accept':
      return 'Accept';
    case 'send_offer':
      return 'Send offer';
    default:
      return 'Decline';
  }
}

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 017 §5, `app/provider/requests` — the provider's incoming-request inbox. Replaces the
 * spec-014 `PlaceholderPage`. `GET /providers/me/requests` is itself distributed-to-only
 * server-side (spec 017 §3), so this page never receives a request the provider was not matched
 * into. Per CLAUDE.md's branding rule, no logo/header of its own — the global AppHeader already
 * provides the page's one brand placement.
 *
 * "Send offer" itself is spec 018's — a quote/custom-priced request shows its action state as
 * informational only (§7 "Out of scope": this spec exposes the action state, not the endpoint).
 */
export default function ProviderRequestsPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [requests, setRequests] = useState<IncomingRequestDto[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [declineTarget, setDeclineTarget] = useState<IncomingRequestDto | null>(null);

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await apiFetch<IncomingRequestDto[]>('/api/v1/providers/me/requests');
    if (!res.ok) {
      setPageStatus('error');
      setPageError(describeError(res.error, "Couldn't load your requests."));
      return;
    }
    setRequests(res.data!);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
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
                  {responded ? (
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

                {!responded ? (
                  <div className={styles.requestActions}>
                    {request.availableAction === 'accept' ? (
                      <Button variant="primary" loading={isPending} onClick={() => respond(request.requestId, 'accept')}>
                        Accept
                      </Button>
                    ) : request.availableAction === 'send_offer' ? (
                      <Button variant="primary" disabled title="Sending offers is coming soon">
                        {actionLabel(request.availableAction)} (coming soon)
                      </Button>
                    ) : null}
                    <Button variant="ghost" onClick={() => setDeclineTarget(request)}>
                      Decline
                    </Button>
                  </div>
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
          declineTarget
            ? `You won't be able to accept "${declineTarget.serviceName}" after declining it.`
            : undefined
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
