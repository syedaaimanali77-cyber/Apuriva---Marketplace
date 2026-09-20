'use client';

/**
 * Spec 032 §5 — one ticket and its thread (AC-3).
 *
 * WHAT THIS PAGE CANNOT SHOW is as designed as what it does. The participant DTO has no field for
 * the assigned admin, the AI summary, the SLA clock, the legal hold or an escalation pointer, so
 * there is nothing here to render even by mistake. The SLA in particular is deliberately absent:
 * it is an internal operational target, and showing a countdown would turn it into a promise.
 *
 * An official reply is shown as from "Support", never from a named individual — the user is talking
 * to the platform, and an admin who replies is not thereby exposed to someone who may be upset.
 *
 * The composer closes with the ticket, with an explanatory line rather than silently.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { SupportMessageDto, SupportTicketDto } from '@/lib/types/support';
import styles from '../../support.module.css';

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  assigned: 'With a support admin',
  awaiting_user: 'Waiting for your reply',
  resolved: 'Resolved',
  closed: 'Closed',
};

export default function SupportTicketPage() {
  const params = useParams<{ id: string }>();
  const ticketId = params.id;

  const [ticket, setTicket] = useState<SupportTicketDto | null>(null);
  const [messages, setMessages] = useState<SupportMessageDto[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [ticketResult, threadResult] = await Promise.all([
      apiFetch<SupportTicketDto>(`/api/v1/support/tickets/${ticketId}`),
      apiFetch<SupportMessageDto[]>(`/api/v1/support/tickets/${ticketId}/messages`),
    ]);
    if (ticketResult.ok && ticketResult.data) setTicket(ticketResult.data);
    else setError('We could not load this request.');
    if (threadResult.ok && threadResult.data) setMessages(threadResult.data);
    setLoading(false);
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling on the cadence the booking screens already use, stopping once the ticket is closed.
  // No WebSocket, because this repository has none.
  useEffect(() => {
    if (ticket?.status === 'closed') return;
    const timer = setInterval(() => void load(), 20_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load, ticket?.status]);

  const send = useCallback(async () => {
    if (draft.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await apiFetch<SupportMessageDto>(`/api/v1/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ body: draft }),
    });
    if (result.ok) {
      setDraft(''); // cleared only once the server has it
      await load();
    } else {
      // The draft is deliberately kept so nothing the user typed is lost.
      setError('We could not send that reply. Your message has been kept — please try again.');
    }
    setBusy(false);
  }, [draft, ticketId, load]);

  const act = useCallback(
    async (action: 'reopen' | 'close') => {
      setBusy(true);
      setError(null);
      const result = await apiFetch<SupportTicketDto>(`/api/v1/support/tickets/${ticketId}/${action}`, {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify({}),
      });
      if (result.ok) await load();
      else if (result.error?.code === 'SUPPORT_REOPEN_LIMIT_REACHED') {
        setError('This request has already been reopened once. Please start a new one.');
      } else if (result.error?.code === 'SUPPORT_REOPEN_WINDOW_ELAPSED') {
        setError('The period for reopening this request has passed. Please start a new one.');
      } else if (result.error?.code === 'SUPPORT_TICKET_STATUS_CONFLICT') {
        setError('This request changed while you were looking at it. We have refreshed it.');
        await load();
      } else {
        setError('That did not work. Please try again.');
      }
      setBusy(false);
    },
    [ticketId, load],
  );

  if (loading) {
    return (
      <main className={styles.page}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </main>
    );
  }

  if (!ticket) {
    return (
      <main className={styles.page}>
        <ErrorState title="Request not found" description={error ?? 'We could not find this request.'} />
      </main>
    );
  }

  const live = ticket.status === 'open' || ticket.status === 'assigned' || ticket.status === 'awaiting_user';

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{ticket.subject}</h1>
      <div className={styles.meta}>
        {/* Status is conveyed by TEXT as well as by the badge's colour, per spec 043. */}
        <Badge>{STATUS_LABELS[ticket.status] ?? ticket.status}</Badge>
        <span>Opened {new Date(ticket.createdAt).toLocaleDateString()}</span>
        {ticket.context && ticket.context.available ? <span>Linked to a {ticket.context.type}</span> : null}
      </div>

      {error ? <ErrorState title="Something went wrong" description={error} /> : null}

      {ticket.status === 'resolved' ? (
        <Card>
          <h2 className={styles.sectionTitle}>Resolved</h2>
          {/* The REASON, not just the outcome — master §2.3. */}
          {ticket.resolutionReason ? <p className={styles.body}>{ticket.resolutionReason}</p> : null}
          {ticket.reopenBy ? (
            <p className={styles.help}>
              If this did not sort it out, you can reopen this request until{' '}
              {new Date(ticket.reopenBy).toLocaleDateString()}.
            </p>
          ) : null}
          <div className={styles.actions}>
            {ticket.reopenCount < 1 ? (
              <Button onClick={() => act('reopen')} disabled={busy} variant="secondary">
                Reopen
              </Button>
            ) : null}
            <Button onClick={() => act('close')} disabled={busy}>
              That is sorted, close it
            </Button>
          </div>
        </Card>
      ) : null}

      <h2 className={styles.sectionTitle}>Conversation</h2>
      <div className={styles.thread} aria-live="polite">
        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.author === 'support' ? `${styles.message} ${styles.messageFromSupport}` : styles.message
            }
          >
            <div className={styles.messageAuthor}>{message.author === 'support' ? 'Support' : 'You'}</div>
            <div className={styles.messageBody}>{message.body}</div>
            <div className={styles.messageTime}>{new Date(message.createdAt).toLocaleString()}</div>
          </div>
        ))}
      </div>

      {live ? (
        <Card>
          <div className={styles.composer}>
            <label className={styles.label} htmlFor="support-reply">
              {ticket.status === 'awaiting_user' ? 'Support asked you a question' : 'Add a reply'}
            </label>
            <Textarea
              id="support-reply"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={4}
              maxLength={2000}
            />
            <div className={styles.actions}>
              <Button onClick={send} disabled={busy || draft.trim().length === 0}>
                {busy ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        // Disabled with an explanation, never silently.
        <p className={styles.help}>
          This request is {STATUS_LABELS[ticket.status]?.toLowerCase() ?? ticket.status}, so it is no
          longer open for replies.
        </p>
      )}
    </main>
  );
}
