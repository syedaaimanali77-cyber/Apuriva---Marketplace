'use client';

/**
 * Spec 038 §5 — the fraud/abuse signal queue.
 *
 * A SIGNAL IS A REVIEW ITEM, NEVER A VERDICT (AC-3). Nothing on this screen restricts, suspends or
 * bans anyone: "Take action" opens the account's moderation page, where a HUMAN chooses an action
 * with a reason — and a ban still needs a second admin. Dismiss and escalate are conditional on the
 * status the admin was shown, so two admins cannot silently overwrite each other.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, FormField, Skeleton, Table, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { FraudSignalDto } from '@/lib/types/moderation';
import styles from '../../admin.module.css';

const RULE_LABELS: Record<string, string> = {
  repeated_safety_reports: 'Repeated safety reports',
  repeated_no_show_fault: 'Repeated confirmed no-shows',
};

type Triage = 'dismiss' | 'escalate';

export default function AdminFraudSignalsPage() {
  const [signals, setSignals] = useState<FraudSignalDto[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ signal: FraudSignalDto; triage: Triage } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<FraudSignalDto[]>('/api/v1/admin/fraud-signals');
    if (!response.ok) {
      setPageError(response.error?.message ?? 'The signal queue could not be loaded.');
      setSignals([]);
      return;
    }
    setSignals((response.data ?? []).filter((s) => s.status === 'pending_review' || s.status === 'escalated'));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const triage = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setFormError(null);
    const response = await apiFetch<FraudSignalDto>(`/api/v1/admin/fraud-signals/${selected.signal.id}/${selected.triage}`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': `${selected.signal.id}:${selected.triage}:${selected.signal.status}` }),
      body: JSON.stringify({ expectedStatus: selected.signal.status, reason: reason.trim() }),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(response.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }
    setSelected(null);
    setReason('');
    await load();
  }, [load, reason, selected]);

  if (signals === null) {
    return (
      <main className={styles.page} data-density="dense">
        <Skeleton />
      </main>
    );
  }

  if (pageError) {
    return (
      <main className={styles.page} data-density="dense">
        <ErrorState title="Signal queue unavailable" description={pageError} />
      </main>
    );
  }

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Fraud &amp; abuse signals</h1>
      <p className={styles.sectionDescription}>
        Rule-based review items. A signal enforces nothing — any action is taken by a person, with a reason.
      </p>

      {signals.length === 0 ? (
        <EmptyState icon="shield-check" title="No signals pending review" description="New signals appear here when a configured rule is met." />
      ) : (
        <Table
          caption="Fraud and abuse signals awaiting review"
          rows={signals}
          columns={[
            { key: 'rule', header: 'Rule', render: (row: FraudSignalDto) => RULE_LABELS[row.ruleKey] ?? row.ruleKey },
            {
              key: 'observed',
              header: 'Observed',
              render: (row: FraudSignalDto) => `${row.observedCount} (threshold ${row.threshold}, ${row.windowDays} days)`,
            },
            { key: 'status', header: 'Status', render: (row: FraudSignalDto) => <Badge tone={row.status === 'escalated' ? 'warning' : 'neutral'}>{row.status}</Badge> },
            { key: 'source', header: 'Source', render: (row: FraudSignalDto) => row.source },
            {
              key: 'actions',
              header: <span className={styles.visuallyHidden}>Actions</span>,
              render: (row: FraudSignalDto) => (
                <div className={styles.actions}>
                  <Link href={`/admin/users/${row.targetUserId}/moderation?signal=${row.id}`}>Take action</Link>
                  <Button size="sm" variant="secondary" onClick={() => setSelected({ signal: row, triage: 'dismiss' })}>
                    Dismiss
                  </Button>
                  {row.status === 'pending_review' ? (
                    <Button size="sm" variant="secondary" onClick={() => setSelected({ signal: row, triage: 'escalate' })}>
                      Escalate
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      )}

      {selected ? (
        <Card>
          <section aria-labelledby="triage-heading" className={styles.section}>
            <h2 id="triage-heading" className={styles.sectionTitle}>
              {selected.triage === 'dismiss' ? 'Dismiss this signal' : 'Escalate this signal'}
            </h2>
            <FormField label="Reason (recorded in the audit log)" htmlFor="triage-reason" required>
              <Textarea
                id="triage-reason"
                value={reason}
                maxLength={500}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
                disabled={busy}
              />
            </FormField>
            {formError ? (
              <Alert tone="error" title="Not saved">
                {formError}
              </Alert>
            ) : null}
            <div className={styles.actions}>
              <Button onClick={() => void triage()} disabled={busy || reason.trim().length === 0}>
                Save
              </Button>
              <Button variant="secondary" onClick={() => setSelected(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </section>
        </Card>
      ) : null}
    </main>
  );
}
