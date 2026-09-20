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
import type { SupportAssistantAnswerDto, SupportTicketSummaryDto } from '@/lib/types/support';
import styles from './support.module.css';

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  assigned: 'With a support admin',
  awaiting_user: 'Waiting for your reply',
  resolved: 'Resolved',
  closed: 'Closed',
};

export default function SupportHomePage() {
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
      setListError('We could not load your past requests.');
      setTickets([]);
    }
  }, []);

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
      <h1 className={styles.title}>Get help</h1>
      <p className={styles.body}>
        Ask a question and we will try to answer it straight away. You can always talk to a person
        instead.
      </p>

      <Card>
        <div className={styles.assistant}>
          <label className={styles.label} htmlFor="support-question">
            What do you need help with?
          </label>
          <Textarea
            id="support-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="For example: how do I cancel a booking?"
          />
          <div className={styles.row}>
            <Button onClick={ask} disabled={asking || question.trim().length === 0}>
              {asking ? 'Asking…' : 'Ask'}
            </Button>
          </div>

          {/* Announced to assistive technology without stealing focus. */}
          <div aria-live="polite">
            {asking ? <Skeleton /> : null}
            {!asking && answer?.available && answer.answer ? (
              <div className={styles.assistantAnswer}>{answer.answer}</div>
            ) : null}
            {!asking && answer && !answer.available ? (
              <p className={styles.help}>
                We could not answer that automatically just now. A person can help you instead.
              </p>
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
          <Button variant="primary">Talk to a human</Button>
        </Link>
        <span className={styles.help}>A support admin will reply in your ticket.</span>
      </div>

      <h2 className={styles.sectionTitle}>Your past requests</h2>
      {listError ? <ErrorState title="Something went wrong" description={listError} /> : null}
      {tickets === null ? (
        <Skeleton />
      ) : tickets.length === 0 ? (
        <EmptyState
          title="You have not contacted support yet"
          description="When you do, your requests and their replies will appear here."
        />
      ) : (
        <div className={styles.ticketList}>
          {tickets.map((ticket) => (
            <Link key={ticket.id} href={`/support/tickets/${ticket.id}`}>
              <ListRow
                title={ticket.subject}
                subtitle={`${STATUS_LABELS[ticket.status] ?? ticket.status} · ${new Date(ticket.createdAt).toLocaleDateString()}`}
              />
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
