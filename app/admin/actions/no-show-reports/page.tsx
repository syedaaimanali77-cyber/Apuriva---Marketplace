'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorState, FormField, Select, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import { NO_SHOW_OUTCOMES, type AdminNoShowReportDto, type NoShowOutcome } from '@/lib/types/no-show';
import styles from '../../admin.module.css';

/**
 * Spec 023 §5 "Admin (Trust & Safety)" — the review queue and the resolution form.
 *
 * The screen presents EVIDENCE AS FACTS, never as a conclusion: booking timing, the attendance
 * instants taken from the booking's own status history, whether communications exist, and the coarse
 * location signal — explicitly labelled as supporting context only, because master spec §51 forbids
 * deciding a no-show on GPS or timestamps alone, and a reviewer reading a screen that implied
 * otherwise would be the easiest way for that rule to be broken in practice.
 *
 * Resolution requires a reason (master spec §68) and offers an outcome from a closed set. There is
 * deliberately no amount field: the financial consequence is computed from the booking's snapshotted
 * policy version, so an admin decides what happened, never what it costs.
 */
const OUTCOME_LABELS: Record<NoShowOutcome, string> = {
  no_show_confirmed_customer: 'Customer did not attend',
  no_show_confirmed_provider: 'Provider did not attend',
  no_fault: 'Neither party at fault',
  inconclusive: 'Not enough information',
  escalated_to_dispute: 'Escalate to dispute resolution',
};

const LOCATION_LABELS: Record<string, string> = {
  address_within_service_area: 'Booking address is inside the provider’s declared service area',
  address_outside_service_area: 'Booking address is outside the provider’s declared service area',
  unavailable: 'No location signal available',
};

export default function AdminNoShowReportsPage() {
  const [reports, setReports] = useState<AdminNoShowReportDto[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminNoShowReportDto | null>(null);
  const [outcome, setOutcome] = useState<NoShowOutcome>('inconclusive');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<AdminNoShowReportDto[]>('/api/v1/admin/no-show-reports');
    if (!response.ok || !Array.isArray(response.data)) {
      setPageError(response.error?.message ?? 'The no-show queue could not be loaded.');
      setReports([]);
      return;
    }
    setPageError(null);
    setReports(response.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setFormError(null);
    const response = await apiFetch<AdminNoShowReportDto>(`/api/v1/admin/no-show-reports/${selected.id}/resolve`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ outcome, reason }),
    });
    setBusy(false);
    if (!response.ok) {
      setFormError(response.error?.message ?? 'This report could not be resolved.');
      return;
    }
    setSelected(null);
    setReason('');
    await load();
  }, [selected, outcome, reason, load]);

  if (reports === null) return <Skeleton />;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>No-show reports</h1>
      <p className={styles.subtitle}>
        Trust &amp; Safety review. Nothing here is decided automatically — each report is closed by a named reviewer.
      </p>

      {pageError ? <ErrorState description={pageError} onRetry={load} /> : null}

      {reports.length === 0 ? <Card>No reports to review.</Card> : null}

      {reports.map((report) => (
        <Card key={report.id}>
          <Badge>{report.status}</Badge>
          <dl>
            <dt>Booking</dt>
            <dd>{report.bookingId}</dd>
            <dt>Reported by</dt>
            <dd>{report.reporterRole}</dd>
            <dt>Response</dt>
            <dd>
              {report.responseStatus === 'filed'
                ? 'Filed'
                : report.responseStatus === 'no_response'
                  ? 'No response within the window'
                  : `Awaiting response until ${report.respondByAt}`}
            </dd>
            <dt>Scheduled</dt>
            <dd>{report.evidence?.scheduledAt ?? '—'}</dd>
            <dt>Minutes after scheduled time (at report)</dt>
            <dd>{report.evidence?.minutesAfterScheduled ?? '—'}</dd>
            <dt>Provider marked en route</dt>
            <dd>{report.evidence?.reachedProviderEnRouteAt ?? 'Never'}</dd>
            <dt>Provider marked arrived</dt>
            <dd>{report.evidence?.reachedArrivedAt ?? 'Never'}</dd>
            <dt>Service started</dt>
            <dd>{report.evidence?.reachedInProgressAt ?? 'Never'}</dd>
            <dt>Messages</dt>
            <dd>{report.evidence?.communications.available ? 'Available' : 'Not available'}</dd>
            <dt>Location (supporting context only)</dt>
            <dd>{LOCATION_LABELS[report.locationSignal]}</dd>
            <dt>Reporter’s statement</dt>
            <dd>{report.reporterStatement ?? '—'}</dd>
            <dt>Response statement</dt>
            <dd>{report.responseStatement ?? '—'}</dd>
          </dl>

          <p>
            Location is supporting context only and must never be the sole basis for a finding. A report can be resolved
            with no location signal at all.
          </p>

          {report.status === 'resolved' ? (
            <p>
              Resolved as <strong>{OUTCOME_LABELS[report.outcome!] ?? report.outcome}</strong> by admin{' '}
              {report.resolvedByAdminId} at {report.resolvedAt}. Reason: {report.resolutionReason}
            </p>
          ) : (
            <Button onClick={() => setSelected(report)} disabled={report.status !== 'under_review'}>
              {report.status === 'under_review' ? 'Resolve' : 'Awaiting response'}
            </Button>
          )}
        </Card>
      ))}

      {selected ? (
        <Card>
          <h2 className={styles.sectionTitle}>Resolve report</h2>
          {formError ? <ErrorState description={formError} /> : null}
          <FormField label="Outcome" htmlFor="no-show-outcome">
            <Select
              id="no-show-outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value as NoShowOutcome)}
              options={NO_SHOW_OUTCOMES.map((value) => ({ value, label: OUTCOME_LABELS[value] }))}
            />
          </FormField>
          <FormField label="Reason" htmlFor="no-show-reason" required>
            <Textarea
              id="no-show-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
            />
          </FormField>
          <p>
            The financial consequence is calculated from the booking’s own cancellation policy. You are recording what
            happened, not choosing an amount.
          </p>
          <Button onClick={() => void resolve()} disabled={busy || reason.trim().length === 0}>
            {busy ? 'Resolving…' : 'Confirm resolution'}
          </Button>
          <Button variant="ghost" onClick={() => setSelected(null)} disabled={busy}>
            Cancel
          </Button>
        </Card>
      ) : null}
    </main>
  );
}
