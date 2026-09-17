'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, ErrorState, FormField, PriceDisplay, Skeleton, Textarea } from '@/components';
import type { NegotiationSenderRole, OfferMessageDto } from '@/lib/types/negotiation';
import styles from './request-message-thread.module.css';

/** Spec 019 §5: no WebSocket layer exists — an open thread refetches this often (spec 018's cadence). */
export const THREAD_REFRESH_INTERVAL_MS = 10_000;
export const MESSAGE_MAX_LENGTH = 1000;

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

/**
 * The fields the thread renders. Spec 019's `OfferMessageDto` and spec 025's booking `MessageDto` both
 * satisfy it; `kind`/`proposedPrice` exist only on the former and simply render nothing when absent.
 */
export interface ThreadMessage {
  id: string;
  senderRole: NegotiationSenderRole;
  body: string;
  contactRedacted: boolean;
  createdAt: string;
  kind?: string;
  proposedPrice?: { amountMinorUnits: number; currencyCode: string } | null;
}

/**
 * Spec 025 §3 "Real-time transport" — authenticated polling with a cursor delta. When set, the thread
 * loads the full history once, then polls `listUrl?after=<createdAtISO>|<id>` on `intervalMs` while the
 * tab is visible, backs off exponentially (capped) after a failure and by `Retry-After` after a `429`,
 * and resumes from its last cursor — so it can never miss a message and needs no replay buffer.
 */
export interface LiveThreadOptions {
  intervalMs: number;
  deltaLimit: number;
  maxBackoffMs: number;
}

export interface RequestMessageThreadProps<M extends ThreadMessage = OfferMessageDto> {
  /** GET endpoint for this thread's messages (paged). */
  listUrl: string;
  /** POST endpoint for a new message. */
  postUrl: string;
  viewerRole: NegotiationSenderRole;
  /** How the other party is named, e.g. the provider's business name or "Customer". */
  counterpartyLabel: string;
  /** The server's last known answer; a closed-code response also closes the composer. */
  canSend?: boolean;
  closedMessage: string;
  /** Receives every authoritative message list (e.g. so the provider inbox can surface a change request). */
  onMessages?: (messages: M[]) => void;

  // Spec 025 §5 generalization. Every default below reproduces spec 019's behaviour exactly.
  /** Rendered when the thread has no messages. */
  emptyContent?: ReactNode;
  /** The composer's help text. */
  composerHelp?: string;
  maxLength?: number;
  /** The dismissible notice shown after the server masked contact details. */
  redactionNotice?: string;
  /** Send error codes that make the thread read-only. */
  closedCodes?: readonly string[];
  /** Send error codes meaning the sender may no longer post (spec 025 AC-6). History stays visible. */
  blockedCodes?: readonly string[];
  blockedMessage?: string;
  /** Keep the drafted text's `Idempotency-Key` after a failed send, so a retry can never duplicate. */
  retainKeyOnFailure?: boolean;
  /** Polling transport; without it the thread refetches its first page on spec 019's cadence. */
  live?: LiveThreadOptions;
  /** Announce newly arrived counterparty messages as one polite aggregate, never their bodies. */
  announceIncoming?: boolean;
  /** Extra per-message metadata, e.g. a read timestamp. */
  renderMessageMeta?: (message: M) => ReactNode;
}

const DEFAULT_CLOSED_CODES = ['THREAD_CLOSED'] as const;
const NO_CODES: readonly string[] = [];
/** A bounded history load: the most a single thread view pages through on open. */
const MAX_HISTORY_PAGES = 50;

function compareMessages(a: ThreadMessage, b: ThreadMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Adds `incoming` to `current` without duplicates, in the server's total order. */
function mergeMessages<M extends ThreadMessage>(current: M[], incoming: M[]): M[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages);
}

/**
 * Spec 019 §5 — a request-scoped, pre-selection thread (AC-1, AC-7, AC-8), generalized in place by spec 025
 * §5 for the post-booking conversation. App-level composition of the Design System (`Textarea`, `Button`,
 * `Alert`, …): no chat primitive exists in `ui/`, and none is added.
 *
 * The server is the authority for everything: contact details are handled server-side before storage and
 * reported back as `contactRedacted`; rate limits answer `429` with `Retry-After`; a closed thread answers
 * a closed code. A message renders only from a server response — there is no optimistic bubble. A failed
 * send always keeps the drafted text. New messages are not announced one by one.
 */
export function RequestMessageThread<M extends ThreadMessage = OfferMessageDto>({
  listUrl,
  postUrl,
  viewerRole,
  counterpartyLabel,
  canSend = true,
  closedMessage,
  onMessages,
  emptyContent,
  composerHelp = "Don't share phone numbers or emails — they are removed.",
  maxLength = MESSAGE_MAX_LENGTH,
  redactionNotice = 'Contact details were removed — keep communication on APURIVA.',
  closedCodes = DEFAULT_CLOSED_CODES,
  blockedCodes = NO_CODES,
  blockedMessage = 'You can no longer send messages in this conversation.',
  retainKeyOnFailure = false,
  live,
  announceIncoming = false,
  renderMessageMeta,
}: RequestMessageThreadProps<M>) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [messages, setMessages] = useState<M[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [closed, setClosed] = useState(!canSend);
  const [blocked, setBlocked] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [redactedNotice, setRedactedNotice] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;

  /** The last message received from a LIST response — never advanced by a send (§3 "Ordering"). */
  const cursorRef = useRef<M | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const stoppedRef = useRef(!canSend);
  stoppedRef.current = closed || blocked;

  useEffect(() => {
    setClosed(!canSend);
  }, [canSend]);

  const publish = useCallback((next: M[]) => {
    setMessages(next);
    onMessagesRef.current?.(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${listUrl}?limit=100`, { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(json.data)) {
        setStatus((current) => (current === 'ready' ? current : 'error'));
        return;
      }
      setMessages(json.data as M[]);
      setStatus('ready');
      onMessagesRef.current?.(json.data as M[]);
    } catch {
      setStatus((current) => (current === 'ready' ? current : 'error'));
    }
  }, [listUrl]);

  // Spec 019 transport: refetch the first page on a fixed cadence.
  useEffect(() => {
    if (live) return;
    load();
    const handle = setInterval(load, THREAD_REFRESH_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [load, live]);

  // Spec 025 transport: full history once, then cursor delta polls.
  const messagesRef = useRef<M[]>([]);
  messagesRef.current = messages;
  const liveIntervalMs = live?.intervalMs;
  const liveDeltaLimit = live?.deltaLimit;
  const liveMaxBackoffMs = live?.maxBackoffMs;

  const loadHistory = useCallback(async (): Promise<boolean> => {
    let all: M[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const res = await fetch(`${listUrl}?limit=100&offset=${offset}`, { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(json.data)) return false;
      all = all.concat(json.data as M[]);
      const nextOffset = json.page?.nextOffset;
      if (typeof nextOffset !== 'number') break;
      offset = nextOffset;
    }
    const merged = mergeMessages(messagesRef.current, all);
    cursorRef.current = all.length > 0 ? all[all.length - 1]! : cursorRef.current;
    publish(merged);
    setStatus('ready');
    return true;
  }, [listUrl, publish]);

  useEffect(() => {
    if (liveIntervalMs === undefined || liveDeltaLimit === undefined || liveMaxBackoffMs === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    /** When the current run of failed polls began — reported as the resumed gap (spec 025 §9). */
    let failingSince: number | null = null;
    let historyLoaded = false;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delayMs);
    };

    const tick = async () => {
      if (cancelled) return;
      // A closed or blocked thread still shows its history; it only stops polling for new messages.
      if (historyLoaded && stoppedRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; // resumes on visibility
      try {
        if (!historyLoaded) {
          historyLoaded = await loadHistory();
          if (!historyLoaded) throw new Error('history');
        } else {
          const cursor = cursorRef.current;
          const resumed =
            cursor && failures > 0 && failingSince !== null
              ? `&resumed=${failures}:${Math.round((Date.now() - failingSince) / 1000)}`
              : '';
          const query = cursor
            ? `after=${encodeURIComponent(`${cursor.createdAt}|${cursor.id}`)}&limit=${liveDeltaLimit}${resumed}`
            : `limit=${liveDeltaLimit}`;
          const res = await fetch(`${listUrl}?${query}`, { credentials: 'same-origin' });
          const json = await res.json().catch(() => ({}));
          if (res.status === 429) {
            const retryAfter = Number(res.headers?.get?.('Retry-After') ?? '');
            failures = 0;
            schedule(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : liveMaxBackoffMs);
            return;
          }
          if (!res.ok || !Array.isArray(json.data)) throw new Error('poll');
          const incoming = json.data as M[];
          if (incoming.length > 0) {
            const known = new Set(messagesRef.current.map((message) => message.id));
            const fresh = incoming.filter((message) => !known.has(message.id) && message.senderRole !== viewerRole);
            cursorRef.current = incoming[incoming.length - 1]!;
            publish(mergeMessages(messagesRef.current, incoming));
            if (announceIncoming && fresh.length > 0) {
              setAnnouncement(
                fresh.length === 1
                  ? `1 new message from ${counterpartyLabel}`
                  : `${fresh.length} new messages from ${counterpartyLabel}`,
              );
            }
          }
        }
        failures = 0;
        failingSince = null;
        setReconnecting(false);
        schedule(liveIntervalMs);
      } catch {
        failures += 1;
        failingSince ??= Date.now();
        if (!historyLoaded) setStatus((current) => (current === 'ready' ? current : 'error'));
        else setReconnecting(true);
        schedule(Math.min(liveIntervalMs * 2 ** failures, liveMaxBackoffMs));
      }
    };

    const resume = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      schedule(0);
    };

    schedule(0);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [listUrl, liveIntervalMs, liveDeltaLimit, liveMaxBackoffMs, loadHistory, publish, announceIncoming, counterpartyLabel, viewerRole]);

  const retryLoad = useCallback(() => {
    if (!live) {
      void load();
      return;
    }
    setStatus('loading');
    void loadHistory().then((ok) => {
      if (!ok) setStatus('error');
    });
  }, [live, load, loadHistory]);

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
    const idempotencyKey = (retainKeyOnFailure && pendingKeyRef.current) || crypto.randomUUID();
    pendingKeyRef.current = idempotencyKey;
    try {
      const res = await fetch(postUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': readCsrfCookie(),
          // One key per drafted message: fresh per submission, or kept across retries when requested.
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!retainKeyOnFailure) pendingKeyRef.current = null;
        if (closedCodes.includes(json.code)) {
          setClosed(true);
        } else if (blockedCodes.includes(json.code)) {
          setBlocked(true);
        } else if (json.code === 'RATE_LIMITED') {
          const retryAfter = res.headers?.get?.('Retry-After') ?? null;
          setSendError(retryAfter ? `You can send another message in ${retryAfter} s.` : 'You are sending messages too quickly. Try again shortly.');
        } else {
          setSendError(json.message ?? "Couldn't send your message.");
        }
        return; // The drafted text is kept.
      }
      pendingKeyRef.current = null;
      const message = json.data as M;
      setDraft('');
      if (live) publish(mergeMessages(messagesRef.current, [message]));
      else setMessages((previous) => [...previous, message]);
      setRedactedNotice(Boolean(message.contactRedacted));
      setAnnouncement('Message sent.');
    } catch {
      if (!retainKeyOnFailure) pendingKeyRef.current = null;
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
      {status === 'error' ? <ErrorState description="Couldn't load this conversation." onRetry={retryLoad} /> : null}

      {status === 'ready' && messages.length === 0
        ? (emptyContent ?? <p className={styles.hint}>No messages yet — ask a question about this request.</p>)
        : null}

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
              {renderMessageMeta ? renderMessageMeta(message) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {reconnecting ? <p className={styles.hint}>Reconnecting… new messages will appear when the connection returns.</p> : null}

      {redactedNotice ? (
        <Alert tone="warning" title="Contact details removed" onDismiss={() => setRedactedNotice(false)}>
          {redactionNotice}
        </Alert>
      ) : null}

      {closed ? (
        <p className={styles.hint}>{closedMessage}</p>
      ) : blocked ? (
        <p className={styles.hint} role="status">
          {blockedMessage}
        </p>
      ) : (
        <form className={styles.composer} aria-label={`Message ${counterpartyLabel}`} onSubmit={send}>
          {sendError ? (
            <Alert tone="error" title="Message not sent">
              {sendError}
            </Alert>
          ) : null}
          <FormField label="Your message" htmlFor={`thread-${postUrl}`} help={composerHelp}>
            <Textarea
              id={`thread-${postUrl}`}
              maxLength={maxLength}
              value={draft}
              onChange={(event) => {
                // A changed draft is a different request: it must never reuse a failed attempt's key.
                if (event.target.value !== draft) pendingKeyRef.current = null;
                setDraft(event.target.value);
              }}
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
