'use client';

/**
 * Spec 032 §5 — the unified admin support inbox (AC-5).
 *
 * This is master §63's queue. It is sorted by SLA deadline ascending by default, because a queue's
 * job is to surface what is running out of time — and `slaBreached` is computed server-side from
 * the clock, never stored, so it cannot go stale on this screen.
 *
 * A PAUSED TICKET SHOWS "paused" RATHER THAN A COUNTDOWN. A ticket waiting on its requester has a
 * stopped clock and is never breached, and rendering a ticking number for it would read as the
 * admin being late for something that is not theirs to answer.
 *
 * `operations_admin` can reach this page and read it, and can do nothing on it — master §69 gives
 * support tickets to the Support Admin. The actions live on the detail page, each gated by its own
 * permission server-side.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, EmptyState, ErrorState, Select, Skeleton, Table } from '@/components';
import { apiFetch } from '@/app/requests/api-client';
import {
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_TICKET_STATUSES,
  type AdminSupportTicketSummaryDto,
} from '@/lib/types/support';
import shared from '../../admin.module.css';
import styles from './support-admin.module.css';

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  assigned: 'Assigned',
  awaiting_user: 'Awaiting user',
  resolved: 'Resolved',
  closed: 'Closed',
};

function slaLabel(ticket: AdminSupportTicketSummaryDto): string {
  if (ticket.status === 'awaiting_user') return 'Paused — awaiting user';
  if (ticket.status === 'resolved' || ticket.status === 'closed') return '—';
  const deadline = new Date(ticket.slaDeadlineAt).getTime();
  const diffHours = (deadline - Date.now()) / 3_600_000;
  if (ticket.slaBreached) return `Overdue by ${Math.abs(Math.round(diffHours))}h`;
  return `Due in ${Math.max(0, Math.round(diffHours))}h`;
}

export default function AdminSupportQueuePage() {
  const [tickets, setTickets] = useState<AdminSupportTicketSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [breachedOnly, setBreachedOnly] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (category) params.set('category', category);
    if (breachedOnly) params.set('slaBreached', 'true');

    const result = await apiFetch<AdminSupportTicketSummaryDto[]>(
      `/api/v1/admin/support/tickets${params.toString() ? `?${params}` : ''}`,
    );
    if (result.ok && result.data) {
      setTickets(result.data);
      setError(null);
    } else {
      setError(
        result.error?.code === 'FORBIDDEN'
          ? 'You do not have permission to view support tickets.'
          : 'We could not load the support queue.',
      );
      setTickets([]);
    }
  }, [status, priority, category, breachedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className={shared.page}>
      <h1 className={shared.title}>Support</h1>
      <p className={styles.body}>Tickets raised by customers and providers, most urgent first.</p>

      <div className={styles.filters}>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {SUPPORT_TICKET_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Filter by priority">
          <option value="">All priorities</option>
          {SUPPORT_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {SUPPORT_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={() => setBreachedOnly((v) => !v)}>
          {breachedOnly ? 'Showing overdue only' : 'Show overdue only'}
        </Button>
      </div>

      {error ? <ErrorState title="Support queue" description={error} /> : null}

      {tickets === null ? (
        <Skeleton />
      ) : tickets.length === 0 ? (
        <EmptyState title="Queue clear — no open tickets" description="Nothing is waiting for support right now." />
      ) : (
        <Table
          caption="Support tickets, most urgent first"
          columns={[
            {
              key: 'subject',
              header: 'Subject',
              render: (t: AdminSupportTicketSummaryDto) => (
                <Link href={`/admin/operations/support/${t.id}`}>{t.subject}</Link>
              ),
            },
            {
              key: 'priority',
              header: 'Priority',
              // Text as well as colour, per spec 043.
              render: (t: AdminSupportTicketSummaryDto) => <Badge>{t.priority}</Badge>,
            },
            {
              key: 'status',
              header: 'Status',
              render: (t: AdminSupportTicketSummaryDto) => STATUS_LABELS[t.status] ?? t.status,
            },
            { key: 'category', header: 'Category', render: (t: AdminSupportTicketSummaryDto) => t.category },
            {
              key: 'sla',
              header: 'SLA',
              render: (t: AdminSupportTicketSummaryDto) => (
                <>
                  {t.slaBreached ? <Badge>Overdue</Badge> : null} {slaLabel(t)}
                </>
              ),
            },
          ]}
          rows={tickets}
        />
      )}
    </main>
  );
}
