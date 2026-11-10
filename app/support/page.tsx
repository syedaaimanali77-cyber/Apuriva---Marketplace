'use client';

/**
 * Spec 032 §5 — the help entry point (AC-1).
 *
 * THE ESCALATION IS NOT INSIDE THE ASSISTANT PANEL, and that placement is the whole point. "Talk to
 * a human" is rendered as a sibling of the assistant, never as a fallback within it, so it is
 * present before a question is asked, while one is in flight, and after any outcome — including an
 * outage. It is never disabled, not even mid-request.
 *
 * The assistant is best-effort by construction: the route answers `200` in every branch, so this
 * page has no error path for it at all. When `available` is false the panel collapses to one
 * neutral line and nothing else about the page changes.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, EmptyState, ErrorState, ListRow, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDate } from '@/lib/i18n/format';
import type { SupportAssistantAnswerDto, SupportTicketSummaryDto } from '@/lib/types/support';
import styles from './support.module.css';

const STATUS_LABELS: Record<string, MessageKey> = {
  open: 'support.status.open',
  assigned: 'support.status.assigned',
  awaiting_user: 'support.status.awaiting_user',
  resolved: 'support.status.resolved',
  closed: 'support.status.closed',
};

export default function SupportHomePage() {
  const { locale, t } = useLocale();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<SupportAssistantAnswerDto | null>(null);
  const [asking, setAsking] = useState(false);

  const [tickets, setTickets] = useState<SupportTicketSummaryDto[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadTickets = useCallback(async () => {
    const result = await apiFetch<SupportTicketSummaryDto[]>('/api/v1/support/tickets');
    if (result.ok && result.data) {
      setTickets(result.data);
      setListError(null);
    } else {
      setListError(t('support.home.listFailed'));
      setTickets([]);
    }
  }, [t]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const ask = useCallback(async () => {
    if (question.trim().length === 0) return;
    setAsking(true);
    const result = await apiFetch<SupportAssistantAnswerDto>('/api/v1/support/assistant', {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ question }),
    });
    // Even a transport failure must not remove the human path, so this only ever sets the panel.
    setAnswer(
      result.ok && result.data ? result.data : { answer: null, available: false, escalationAvailable: true },
    );
    setAsking(false);
  }, [question]);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('support.home.title')}</h1>
      <p className={styles.body}>{t('support.home.intro')}</p>

      <Card>
        <div className={styles.assistant}>
          <label className={styles.label} htmlFor="support-question">
            {t('support.home.question')}
          </label>
          <Textarea
            id="support-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t('support.home.placeholder')}
          />
          <div className={styles.row}>
            <Button onClick={ask} disabled={asking || question.trim().length === 0}>
              {asking ? t('support.home.asking') : t('support.home.ask')}
            </Button>
          </div>

          {/* Announced to assistive technology without stealing focus. */}
          <div aria-live="polite">
            {asking ? <Skeleton /> : null}
            {!asking && answer?.available && answer.answer ? (
              <div className={styles.assistantAnswer}>{answer.answer}</div>
            ) : null}
            {!asking && answer && !answer.available ? (
              <p className={styles.help}>{t('support.home.cannotAnswer')}</p>
            ) : null}
          </div>
        </div>
      </Card>

      {/*
        OUTSIDE the assistant card, and never disabled: AC-1 requires the human path to be reachable
        in every AI outcome, including while a request is in flight.
      */}
      <div className={styles.escalation}>
        <Link href="/support/new">
          <Button variant="primary">{t('support.home.human')}</Button>
        </Link>
        <span className={styles.help}>{t('support.home.humanHint')}</span>
      </div>

      <h2 className={styles.sectionTitle}>{t('support.home.past')}</h2>
      {listError ? <ErrorState title={t('common.somethingWentWrong')} description={listError} /> : null}
      {tickets === null ? (
        <Skeleton />
      ) : tickets.length === 0 ? (
        <EmptyState
          title={t('support.home.emptyTitle')}
          description={t('support.home.emptyDescription')}
        />
      ) : (
        <div className={styles.ticketList}>
          {tickets.map((ticket) => (
            <Link key={ticket.id} href={`/support/tickets/${ticket.id}`}>
              <ListRow
                title={ticket.subject}
                subtitle={t('support.home.ticketMeta', {
                  status: STATUS_LABELS[ticket.status] ? t(STATUS_LABELS[ticket.status]!) : ticket.status,
                  date: formatDate(ticket.createdAt, locale),
                })}
              />
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
