'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, FormField, Skeleton, Textarea } from '@/components';
import type { NoShowReportDto, NoShowStatus } from '@/lib/types/no-show';
import { apiFetch, mutateHeaders } from '../../booking-client';
import styles from '../../bookings.module.css';

/**
 * Spec 023 §5 "No-show" — NEUTRAL LANGUAGE IS THE REQUIREMENT, not a nicety.
 *
 * Master spec §51 forbids automatically accusing anyone, and that rule is carried in this copy as
 * much as in the backend: no state on this screen says anyone failed to attend. A filed report is
 * "waiting for a response"; a report under review is "being reviewed by our team", worded
 * identically whichever party reported and whether the response was filed or the window simply
 * elapsed. Only a resolution states an outcome, and only after a human decided it.
 *
 * Neither party ever sees the other's statement here — the participant DTO does not carry it.
 */
const STATUS_COPY: Record<NoShowStatus, { label: string; detail: string }> = {
  reported: { label: 'Submitted', detail: 'This report has just been submitted.' },
  awaiting_response: {
    label: 'Waiting for a response',
    detail: 'The other party has been asked to respond. Nothing is decided until they do, or their time to respond passes.',
  },
  under_review: {
    label: 'Under review',
    detail: 'Our team is reviewing this. No conclusion has been reached and no charge has been applied.',
  },
  resolved: { label: 'Resolved', detail: 'Our team has reviewed and closed this report.' },
  withdrawn: { label: 'Withdrawn', detail: 'This report was withdrawn.' },
};

const OUTCOME_COPY: Record<string, string> = {
  no_show_confirmed_customer: 'Reviewed: the customer did not attend.',
  no_show_confirmed_provider: 'Reviewed: the provider did not attend.',
  no_fault: 'Reviewed: neither party was found at fault. The booking was cancelled and fully refunded.',
  inconclusive: 'Reviewed: there was not enough information to reach a conclusion. Nothing was charged.',
  escalated_to_dispute: 'Reviewed and escalated for formal dispute resolution.',
};

export default function NoShowPage() {
  const params = useParams<{ id: string }>();
  const bookingId = params.id;

  const [reports, setReports] = useState<NoShowReportDto[] | null>(null);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<NoShowReportDto[]>(`/api/v1/bookings/${bookingId}/no-show-reports`);
    setReports(response.ok && Array.isArray(response.data) ? response.data : []);
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = useCallback(async () => {
    setBusy(true);
    setError(null);
    const key =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `no-show-${Date.now()}`;
    const response = await apiFetch<NoShowReportDto>(`/api/v1/bookings/${bookingId}/report-no-show`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': key }),
      body: JSON.stringify({ statement: statement.trim() || undefined }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? 'This report could not be submitted.');
      return;
    }
    setStatement('');
    await load();
  }, [bookingId, statement, load]);

  const respond = useCallback(
    async (reportId: string) => {
      setBusy(true);
      setError(null);
      const response = await apiFetch<NoShowReportDto>(`/api/v1/no-show-reports/${reportId}/respond`, {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify({ statement: statement.trim() || undefined }),
      });
      setBusy(false);
      if (!response.ok) {
        setError(response.error?.message ?? 'Your response could not be submitted.');
        return;
      }
      setStatement('');
      await load();
    },
    [statement, load],
  );

  const withdraw = useCallback(
    async (reportId: string) => {
      setBusy(true);
      setError(null);
      const response = await apiFetch<NoShowReportDto>(`/api/v1/no-show-reports/${reportId}/withdraw`, {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify({}),
      });
      setBusy(false);
      if (!response.ok) {
        setError(response.error?.message ?? 'This report could not be withdrawn.');
        return;
      }
      await load();
    },
    [load],
  );

  if (reports === null) {
    return (
      <main className={styles.page}>
        <Skeleton />
      </main>
    );
  }

  const ownReport = reports.find((entry) => entry.isOwnReport);
  const againstMe = reports.find((entry) => !entry.isOwnReport);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Attendance issue</h1>

      {error ? <ErrorState title="Something went wrong" description={error} /> : null}

      {reports.map((entry) => {
        const copy = STATUS_COPY[entry.status];
        return (
          <section key={entry.id} className={styles.section}>
            <h2 className={styles.sectionTitle}>{entry.isOwnReport ? 'Your report' : 'Report about this booking'}</h2>
            <Card>
              <Badge>{copy.label}</Badge>
              <p className={styles.hint}>{copy.detail}</p>
              {entry.status === 'resolved' && entry.outcome ? (
                <p className={styles.detailValue}>{OUTCOME_COPY[entry.outcome] ?? 'Reviewed and closed.'}</p>
              ) : null}
              {entry.status === 'awaiting_response' && entry.isOwnReport ? (
                <div className={styles.actions}>
                  <Button variant="ghost" onClick={() => void withdraw(entry.id)} disabled={busy}>
                    Withdraw report
                  </Button>
                </div>
              ) : null}
            </Card>
          </section>
        );
      })}

      {againstMe && againstMe.status === 'awaiting_response' && !againstMe.responseFiled ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Your response</h2>
          <Card>
            <p className={styles.hint}>
              Tell us what happened from your side. Your response goes to our review team, not to the other party.
            </p>
            <FormField label="What happened?" htmlFor="no-show-response-statement">
              <Textarea
                id="no-show-response-statement"
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                maxLength={4000}
              />
            </FormField>
            <div className={styles.actions}>
              <Button onClick={() => void respond(againstMe.id)} disabled={busy}>
                Send response
              </Button>
            </div>
          </Card>
        </section>
      ) : null}

      {!ownReport ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Report that the other party did not attend</h2>
          <Card>
            <p className={styles.hint}>
              The other party will be asked to respond, and our team decides the outcome. Reporting does not by itself
              charge anyone or cancel the booking.
            </p>
            <FormField label="What happened?" htmlFor="no-show-report-statement" optional>
              <Textarea
                id="no-show-report-statement"
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                maxLength={4000}
              />
            </FormField>
            <div className={styles.actions}>
              <Button onClick={() => void report()} disabled={busy}>
                Submit report
              </Button>
            </div>
          </Card>
        </section>
      ) : null}

      <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
        Back to booking
      </Link>
    </main>
  );
}
