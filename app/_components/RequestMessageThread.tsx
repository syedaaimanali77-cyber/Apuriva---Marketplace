'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, ErrorState, FormField, PriceDisplay, Skeleton, Textarea } from '@/components';
import type { NegotiationSenderRole, OfferMessageDto } from '@/lib/types/negotiation';
import styles from './request-message-thread.module.css';

/** Spec 019 §5: no WebSocket layer exists — an open thread refetches this often (spec 018's cadence). */
export const THREAD_REFRESH_INTERVAL_MS = 10_000;
export const MESSAGE_MAX_LENGTH = 1000;

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

export interface RequestMessageThreadProps {
  /** GET endpoint for this thread's messages (paged). */
  listUrl: string;
  /** POST endpoint for a new message. */
  postUrl: string;
  viewerRole: NegotiationSenderRole;
  /** How the other party is named, e.g. the provider's business name or "Customer". */
  counterpartyLabel: string;
  /** The server's last known answer; a `THREAD_CLOSED` response also closes the composer. */
  canSend?: boolean;
  closedMessage: string;
  /** Receives every authoritative message list (e.g. so the provider inbox can surface a change request). */
  onMessages?: (messages: OfferMessageDto[]) => void;
}

/**
 * Spec 019 §5 — a request-scoped, pre-selection thread (AC-1, AC-7, AC-8). App-level composition of the
 * Design System (`Textarea`, `Button`, `Alert`, …): no chat primitive exists in `ui/`, and none is added.
 *
 * The server is the authority for everything: contact details are removed server-side before storage and
 * reported back as `contactRedacted`; the per-thread limit answers `429` with `Retry-After`; a closed thread
 * answers `THREAD_CLOSED`. A failed send always keeps the drafted text. Each submission sends a fresh
 * `Idempotency-Key`. New messages are not announced one by one (no per-message live region).
 */
export function RequestMessageThread({
  listUrl,
  postUrl,
  viewerRole,
  counterpartyLabel,
  canSend = true,
  closedMessage,
  onMessages,
}: RequestMessageThreadProps) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [messages, setMessages] = useState<OfferMessageDto[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [closed, setClosed] = useState(!canSend);
  const [redactedNotice, setRedactedNotice] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;

  useEffect(() => {
    setClosed(!canSend);
  }, [canSend]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${listUrl}?limit=100`, { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(json.data)) {
        setStatus((current) => (current === 'ready' ? current : 'error'));
        return;
      }
      setMessages(json.data as OfferMessageDto[]);
      setStatus('ready');
      onMessagesRef.current?.(json.data as OfferMessageDto[]);
    } catch {
      setStatus((current) => (current === 'ready' ? current : 'error'));
    }
  }, [listUrl]);

  useEffect(() => {
    load();
    const handle = setInterval(load, THREAD_REFRESH_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [load]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0) {
      setSendError('Write a message first.');
      return;
    }
    setSending(true);
    setSendError(null);
    setRedactedNotice(false);
    try {
      const res = await fetch(postUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': readCsrfCookie(),
          // One fresh key per submission (spec 019 §3 idempotency).
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.code === 'THREAD_CLOSED') {
          setClosed(true);
        } else if (json.code === 'RATE_LIMITED') {
          const retryAfter = res.headers?.get?.('Retry-After') ?? null;
          setSendError(retryAfter ? `You can send another message in ${retryAfter} s.` : 'You are sending messages too quickly. Try again shortly.');
        } else {
          setSendError(json.message ?? "Couldn't send your message.");
        }
        return; // The drafted text is kept.
      }
      const message = json.data as OfferMessageDto;
      setDraft('');
      setMessages((previous) => [...previous, message]);
      setRedactedNotice(Boolean(message.contactRedacted));
      setAnnouncement('Message sent.');
    } catch {
      setSendError("Couldn't send your message.");
    } finally {
      setSending(false);
    }
  }

  const label = (role: NegotiationSenderRole) => (role === viewerRole ? 'You' : counterpartyLabel);

  return (
    <div className={styles.thread}>
      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      {status === 'loading' ? <Skeleton lines={2} /> : null}
      {status === 'error' ? <ErrorState description="Couldn't load this conversation." onRetry={load} /> : null}

      {status === 'ready' && messages.length === 0 ? (
        <p className={styles.hint}>No messages yet — ask a question about this request.</p>
      ) : null}

      {status === 'ready' && messages.length > 0 ? (
        <ol className={styles.list} aria-label={`Conversation with ${counterpartyLabel}`}>
          {messages.map((message) => (
            <li key={message.id} className={`${styles.message} ${message.senderRole === viewerRole ? styles.own : ''}`}>
              <div className={styles.meta}>
                <span>{label(message.senderRole)}</span>
                <span>{new Date(message.createdAt).toLocaleString()}</span>
                {message.kind === 'change_request' ? (
                  <Badge tone="info" size="sm">
                    Change requested
                  </Badge>
                ) : null}
              </div>
              <p className={styles.body}>{message.body}</p>
              {message.proposedPrice ? (
                <p className={styles.hint}>
                  Proposed price:{' '}
                  <PriceDisplay
                    priceDisplay={{
                      type: 'exact',
                      amountMinorUnits: message.proposedPrice.amountMinorUnits,
                      currencyCode: message.proposedPrice.currencyCode,
                    }}
                  />
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {redactedNotice ? (
        <Alert tone="warning" title="Contact details removed" onDismiss={() => setRedactedNotice(false)}>
          Contact details were removed — keep communication on APURIVA.
        </Alert>
      ) : null}

      {closed ? (
        <p className={styles.hint}>{closedMessage}</p>
      ) : (
        <form className={styles.composer} aria-label={`Message ${counterpartyLabel}`} onSubmit={send}>
          {sendError ? (
            <Alert tone="error" title="Message not sent">
              {sendError}
            </Alert>
          ) : null}
          <FormField label="Your message" htmlFor={`thread-${postUrl}`} help="Don't share phone numbers or emails — they are removed.">
            <Textarea
              id={`thread-${postUrl}`}
              maxLength={MESSAGE_MAX_LENGTH}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </FormField>
          <div className={styles.actions}>
            <Button type="submit" variant="primary" loading={sending}>
              Send message
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
