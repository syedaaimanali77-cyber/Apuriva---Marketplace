'use client';

/**
 * Spec 032 §5 — one support ticket in full (AC-5).
 *
 * THE INTERNAL NOTES PANEL IS LABELLED, NOT JUST STYLED. The single mistake that matters most on
 * this screen is an admin believing a note reached the customer, or believing a reply did not — so
 * the panel says "Internal — not visible to the user" in words, and the notes arrive from their own
 * `/notes` request rather than being mixed into the thread.
 *
 * THE AI SUMMARY IS A SUGGESTION, BELOW THE REQUESTER'S OWN WORDS (spec 030's precedent, and for
 * the same reason): a screen that leads with a machine's paraphrase is the easiest way for a tired
 * admin to stop reading what a person actually wrote. Nothing on this page acts on it.
 *
 * THE CONTEXT IS A LINK, NOT AN EXPANSION. Booking, payment and dispute detail belong to specs
 * 021/022/031 and are read through their own permissioned surfaces — this spec widens no existing
 * exposure, so an admin without those permissions simply cannot follow the link.
 *
 * `expectedStatus` goes with every action, so two admins working the queue at once cannot silently
 * overwrite each other.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Select, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import {
  SUPPORT_PRIORITIES,
  type AdminSupportTicketDto,
  type SupportMessageDto,
  type SupportNoteDto,
  type SupportPriority,
} from '@/lib/types/support';
import shared from '../../../admin.module.css';
import styles from '../support-admin.module.css';

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  assigned: 'Assigned',
  awaiting_user: 'Awaiting user',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Where a pointer leads. The detail lives in the owning spec's own workspace, never here. */
function contextHref(type: string, id: string): string | null {
  if (type === 'dispute') return `/admin/operations/disputes/${id}`;
  if (type === 'payment') return '/admin/operations/refunds';
  return null;
}

export default function AdminSupportTicketPage() {
  const params = useParams<{ id: string }>();
  const ticketId = params.id;

  const [ticket, setTicket] = useState<AdminSupportTicketDto | null>(null);
  const [messages, setMessages] = useState<SupportMessageDto[]>([]);
  const [notes, setNotes] = useState<SupportNoteDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [reply, setReply] = useState('');
  const [requestsInformation, setRequestsInformation] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [resolutionKind, setResolutionKind] = useState<'answered' | 'handed_off' | 'not_actionable'>('answered');
  const [handoffTarget, setHandoffTarget] = useState<'safety' | 'dispute' | 'refunds'>('refunds');
  const [priority, setPriority] = useState<SupportPriority>('medium');
  const [confirmPriority, setConfirmPriority] = useState(false);

  const load = useCallback(async () => {
    const [t, m, n] = await Promise.all([
      apiFetch<AdminSupportTicketDto>(`/api/v1/admin/support/tickets/${ticketId}`),
      apiFetch<SupportMessageDto[]>(`/api/v1/support/tickets/${ticketId}/messages`),
      apiFetch<SupportNoteDto[]>(`/api/v1/admin/support/tickets/${ticketId}/notes`),
    ]);
    if (t.ok && t.data) {
      setTicket(t.data);
      setPriority(t.data.priority);
      setError(null);
    } else {
      setError(
        t.error?.code === 'SUPPORT_PARTICIPANT_CONFLICT'
          ? 'You raised this ticket yourself, so you cannot act on it as an admin. You can see it in your own support area.'
          : t.error?.code === 'FORBIDDEN'
            ? 'You do not have permission to view support tickets.'
            : 'We could not load this ticket.',
      );
    }
    if (m.ok && m.data) setMessages(m.data);
    if (n.ok && n.data) setNotes(n.data);
    setLoading(false);
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>, onDone?: () => void) => {
      setBusy(true);
      setError(null);
      const result = await apiFetch(`/api/v1/admin/support/tickets/${ticketId}${path}`, {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify(body),
      });
      if (result.ok) {
        onDone?.();
        await load();
      } else if (result.error?.code === 'SUPPORT_TICKET_STATUS_CONFLICT') {
        setError('Someone else changed this ticket while you were working on it. We have refreshed it.');
        await load();
      } else if (result.error?.code === 'SUPPORT_RESOLUTION_INVALID') {
        setError(result.error.message);
      } else {
        setError('That did not work. Please try again.');
      }
      setBusy(false);
    },
    [ticketId, load],
  );

  /**
   * The admin reply goes to the SHARED messages route, not to an admin-only one: spec 032 §3 keeps
   * one route with two authorization paths, so the thread has a single writer and a single order.
   * `requestsInformation` is what moves the ticket to `awaiting_user` and starts the SLA pause.
   */
  const sendReply = useCallback(async () => {
    if (reply.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await apiFetch<SupportMessageDto>(`/api/v1/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ body: reply, requestsInformation }),
    });
    if (result.ok) {
      setReply('');
      setRequestsInformation(false);
      await load();
    } else if (result.error?.code === 'SUPPORT_TICKET_STATUS_CONFLICT') {
      setError('Someone else changed this ticket while you were replying. We have refreshed it.');
      await load();
    } else {
      // The draft is kept, so nothing typed is lost.
      setError('We could not send that reply. Your message has been kept — please try again.');
    }
    setBusy(false);
  }, [reply, requestsInformation, ticketId, load]);

  if (loading) {
    return (
      <main className={shared.page}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </main>
    );
  }

  if (!ticket) {
    return (
      <main className={shared.page}>
        <ErrorState title="Support ticket" description={error ?? 'We could not load this ticket.'} />
      </main>
    );
  }

  const live = ticket.status === 'open' || ticket.status === 'assigned' || ticket.status === 'awaiting_user';
  const href = ticket.context ? contextHref(ticket.context.type, ticket.context.id) : null;
  // A safety ticket can never be answered away — the option is absent here as well as refused
  // server-side and by the database.
  const kinds = ticket.category === 'safety' ? (['handed_off', 'not_actionable'] as const) : (['answered', 'handed_off', 'not_actionable'] as const);

  return (
    <main className={shared.page}>
      <h1 className={shared.title}>{ticket.subject}</h1>
      <div className={styles.meta}>
        <Badge>{ticket.priority}</Badge>
        <span>{STATUS_LABELS[ticket.status] ?? ticket.status}</span>
        <span>{ticket.category}</span>
        <span>Raised as {ticket.requesterMode}</span>
        {ticket.slaBreached ? <Badge>Overdue</Badge> : null}
        <span>
          {ticket.status === 'awaiting_user'
            ? 'SLA paused — awaiting user'
            : `SLA due ${new Date(ticket.slaDeadlineAt).toLocaleString()}`}
        </span>
        {ticket.legalHold ? <Badge>Legal hold</Badge> : null}
      </div>

      {error ? <ErrorState title="Something went wrong" description={error} /> : null}

      <Card>
        <h2 className={shared.sectionTitle}>What the customer said</h2>
        <p className={styles.messageBody}>{ticket.description}</p>

        {ticket.context ? (
          <p className={styles.contextLink}>
            Linked {ticket.context.type}
            {ticket.context.available ? ` (${ticket.context.status})` : ' — no longer available'}
            {href && ticket.context.available ? (
              <>
                {' · '}
                <Link href={href}>Open it</Link>
              </>
            ) : null}
          </p>
        ) : null}

        {/* Below the customer's own words, and labelled a suggestion. Nothing acts on it. */}
        {ticket.aiSummary ? (
          <>
            <h3 className={styles.label}>AI summary — a suggestion, not a decision</h3>
            <div className={styles.aiSummary}>{ticket.aiSummary}</div>
          </>
        ) : null}
      </Card>

      <h2 className={shared.sectionTitle}>Conversation</h2>
      <div className={styles.thread}>
        {messages.map((message) => (
          <div
            key={message.id}
            className={message.author === 'support' ? `${styles.message} ${styles.messageFromSupport}` : styles.message}
          >
            <div className={styles.messageAuthor}>{message.author === 'support' ? 'Support' : 'Customer'}</div>
            <div className={styles.messageBody}>{message.body}</div>
          </div>
        ))}
      </div>

      {live ? (
        <Card>
          <label className={styles.label} htmlFor="admin-reply">
            Reply to the customer
          </label>
          <Textarea id="admin-reply" value={reply} onChange={(e) => setReply(e.target.value)} rows={4} maxLength={2000} />
          <label className={styles.help}>
            <input
              type="checkbox"
              checked={requestsInformation}
              onChange={(e) => setRequestsInformation(e.target.checked)}
            />{' '}
            This asks the customer for more information (pauses the SLA clock)
          </label>
          <div className={shared.actions}>
            <Button disabled={busy || reply.trim().length === 0} onClick={sendReply}>
              {busy ? 'Sending…' : 'Send reply'}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Internal notes: their own request, their own panel, and said in words. */}
      <div className={styles.internalPanel}>
        <div className={styles.internalBanner}>Internal — not visible to the user</div>
        {notes.map((n) => (
          <p key={n.id} className={styles.note}>
            {n.body}
          </p>
        ))}
        {live ? (
          <>
            <label className={styles.label} htmlFor="admin-note">
              Add an internal note
            </label>
            <Textarea id="admin-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
            <div className={shared.actions}>
              <Button
                variant="secondary"
                disabled={busy || note.trim().length === 0}
                onClick={() => post('/notes', { body: note }, () => setNote(''))}
              >
                Save note
              </Button>
            </div>
          </>
        ) : null}
      </div>

      {live ? (
        <Card>
          <h2 className={shared.sectionTitle}>Actions</h2>

          <label className={styles.label} htmlFor="admin-priority">
            Priority
          </label>
          <Select
            id="admin-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as SupportPriority)}
          >
            {SUPPORT_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>

          <label className={styles.label} htmlFor="admin-reason">
            Reason (recorded, and shown to the customer on a resolution)
          </label>
          <Textarea id="admin-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} />

          <label className={styles.label} htmlFor="admin-resolution">
            Resolution
          </label>
          <Select
            id="admin-resolution"
            value={resolutionKind}
            onChange={(e) => setResolutionKind(e.target.value as typeof resolutionKind)}
          >
            {kinds.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>

          {resolutionKind === 'handed_off' ? (
            <>
              <label className={styles.label} htmlFor="admin-handoff">
                Hand off to
              </label>
              <Select
                id="admin-handoff"
                value={handoffTarget}
                onChange={(e) => setHandoffTarget(e.target.value as typeof handoffTarget)}
              >
                <option value="refunds">Finance (refunds)</option>
                <option value="safety">Trust &amp; Safety</option>
                <option value="dispute">An existing dispute</option>
              </Select>
            </>
          ) : null}

          <div className={shared.actions}>
            <Button
              variant="secondary"
              disabled={busy || reason.trim().length < 10 || priority === ticket.priority}
              onClick={() => setConfirmPriority(true)}
            >
              Change priority
            </Button>
            <Button
              disabled={busy || reason.trim().length < 10}
              onClick={() =>
                post(
                  '/resolve',
                  {
                    resolutionKind,
                    reason,
                    ...(resolutionKind === 'handed_off' ? { handoffTarget } : {}),
                    expectedStatus: ticket.status,
                  },
                  () => setReason(''),
                )
              }
            >
              Resolve
            </Button>
          </div>

          <ConfirmDialog
            open={confirmPriority}
            title="Change this ticket's priority?"
            description="This recomputes its SLA deadline, and both the old and the new priority are recorded in the audit trail with your reason."
            confirmLabel="Change priority"
            onCancel={() => setConfirmPriority(false)}
            onConfirm={() => {
              setConfirmPriority(false);
              void post('/priority', { priority, reason, expectedStatus: ticket.status }, () => setReason(''));
            }}
          />
        </Card>
      ) : null}
    </main>
  );
}
