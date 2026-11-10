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
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDate, formatDateTime } from '@/lib/i18n/format';
import type { SupportMessageDto, SupportTicketDto } from '@/lib/types/support';
import styles from '../../support.module.css';

const STATUS_LABELS: Record<string, MessageKey> = {
  open: 'support.status.open',
  assigned: 'support.status.assigned',
  awaiting_user: 'support.status.awaiting_user',
  resolved: 'support.status.resolved',
  closed: 'support.status.closed',
};

const LINK_TYPE_LABELS: Record<string, MessageKey> = {
  booking: 'support.ticket.linkType.booking',
  payment: 'support.ticket.linkType.payment',
  dispute: 'support.ticket.linkType.dispute',
};

export default function SupportTicketPage() {
  const { locale, t } = useLocale();
  const statusText = (status: string) => (STATUS_LABELS[status] ? t(STATUS_LABELS[status]!) : status);
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
    else setError(t('support.ticket.loadFailed'));
    if (threadResult.ok && threadResult.data) setMessages(threadResult.data);
    setLoading(false);
  }, [t, ticketId]);

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
      setError(t('support.ticket.replyFailed'));
    }
    setBusy(false);
  }, [draft, ticketId, load, t]);

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
        setError(t('support.ticket.reopenLimit'));
      } else if (result.error?.code === 'SUPPORT_REOPEN_WINDOW_ELAPSED') {
        setError(t('support.ticket.reopenElapsed'));
      } else if (result.error?.code === 'SUPPORT_TICKET_STATUS_CONFLICT') {
        setError(t('support.ticket.statusConflict'));
        await load();
      } else {
        setError(t('support.ticket.actionFailed'));
      }
      setBusy(false);
    },
    [ticketId, load, t],
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
        <ErrorState title={t('support.ticket.notFoundTitle')} description={error ?? t('support.ticket.notFound')} />
      </main>
    );
  }

  const live = ticket.status === 'open' || ticket.status === 'assigned' || ticket.status === 'awaiting_user';

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{ticket.subject}</h1>
      <div className={styles.meta}>
        {/* Status is conveyed by TEXT as well as by the badge's colour, per spec 043. */}
        <Badge>{statusText(ticket.status)}</Badge>
        <span>{t('support.ticket.opened', { date: formatDate(ticket.createdAt, locale) })}</span>
        {ticket.context && ticket.context.available ? (
          <span>
            {t('support.ticket.linked', {
              type: LINK_TYPE_LABELS[ticket.context.type] ? t(LINK_TYPE_LABELS[ticket.context.type]!) : ticket.context.type,
            })}
          </span>
        ) : null}
      </div>

      {error ? <ErrorState title={t('common.somethingWentWrong')} description={error} /> : null}

      {ticket.status === 'resolved' ? (
        <Card>
          <h2 className={styles.sectionTitle}>{t('support.ticket.resolved')}</h2>
          {/* The REASON, not just the outcome — master §2.3. */}
          {ticket.resolutionReason ? <p className={styles.body}>{ticket.resolutionReason}</p> : null}
          {ticket.reopenBy ? (
            <p className={styles.help}>{t('support.ticket.reopenUntil', { date: formatDate(ticket.reopenBy, locale) })}</p>
          ) : null}
          <div className={styles.actions}>
            {ticket.reopenCount < 1 ? (
              <Button onClick={() => act('reopen')} disabled={busy} variant="secondary">
                {t('support.ticket.reopen')}
              </Button>
            ) : null}
            <Button onClick={() => act('close')} disabled={busy}>
              {t('support.ticket.close')}
            </Button>
          </div>
        </Card>
      ) : null}

      <h2 className={styles.sectionTitle}>{t('support.ticket.conversation')}</h2>
      <div className={styles.thread} aria-live="polite">
        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.author === 'support' ? `${styles.message} ${styles.messageFromSupport}` : styles.message
            }
          >
            <div className={styles.messageAuthor}>{message.author === 'support' ? t('support.ticket.support') : t('support.ticket.you')}</div>
            <div className={styles.messageBody}>{message.body}</div>
            <div className={styles.messageTime}>{formatDateTime(message.createdAt, locale)}</div>
          </div>
        ))}
      </div>

      {live ? (
        <Card>
          <div className={styles.composer}>
            <label className={styles.label} htmlFor="support-reply">
              {ticket.status === 'awaiting_user' ? t('support.ticket.askedQuestion') : t('support.ticket.addReply')}
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
                {busy ? t('support.ticket.sending') : t('support.ticket.send')}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        // Disabled with an explanation, never silently.
        <p className={styles.help}>{t('support.ticket.closedForReplies', { status: statusText(ticket.status).toLowerCase() })}</p>
      )}
    </main>
  );
}
