'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Button, Card, ErrorState, FormField, Skeleton, Textarea } from '@/components';
import type { NoShowReportDto, NoShowStatus } from '@/lib/types/no-show';
import { apiFetch, mutateHeaders } from '../../booking-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
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
const STATUS_COPY: Record<NoShowStatus, { label: MessageKey; detail: MessageKey }> = {
  reported: { label: 'noShow.status.reported.label', detail: 'noShow.status.reported.detail' },
  awaiting_response: { label: 'noShow.status.awaiting_response.label', detail: 'noShow.status.awaiting_response.detail' },
  under_review: { label: 'noShow.status.under_review.label', detail: 'noShow.status.under_review.detail' },
  resolved: { label: 'noShow.status.resolved.label', detail: 'noShow.status.resolved.detail' },
  withdrawn: { label: 'noShow.status.withdrawn.label', detail: 'noShow.status.withdrawn.detail' },
};

const OUTCOME_COPY: Record<string, MessageKey> = {
  no_show_confirmed_customer: 'noShow.outcome.no_show_confirmed_customer',
  no_show_confirmed_provider: 'noShow.outcome.no_show_confirmed_provider',
  no_fault: 'noShow.outcome.no_fault',
  inconclusive: 'noShow.outcome.inconclusive',
  escalated_to_dispute: 'noShow.outcome.escalated_to_dispute',
};

export default function NoShowPage() {
  const { t, errorText } = useLocale();
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
      setError(errorText(response.error?.code, response.error?.message, t('noShow.reportFailed')));
      return;
    }
    setStatement('');
    await load();
  }, [bookingId, errorText, statement, load, t]);

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
        setError(errorText(response.error?.code, response.error?.message, t('noShow.respondFailed')));
        return;
      }
      setStatement('');
      await load();
    },
    [errorText, statement, load, t],
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
        setError(errorText(response.error?.code, response.error?.message, t('noShow.withdrawFailed')));
        return;
      }
      await load();
    },
    [errorText, load, t],
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
      <h1 className={styles.title}>{t('noShow.title')}</h1>

      {error ? <ErrorState title={t('common.somethingWentWrong')} description={error} /> : null}

      {reports.map((entry) => {
        const copy = STATUS_COPY[entry.status];
        return (
          <section key={entry.id} className={styles.section}>
            <h2 className={styles.sectionTitle}>{entry.isOwnReport ? t('noShow.yourReport') : t('noShow.reportAbout')}</h2>
            <Card>
              <Badge>{t(copy.label)}</Badge>
              <p className={styles.hint}>{t(copy.detail)}</p>
              {entry.status === 'resolved' && entry.outcome ? (
                <p className={styles.detailValue}>{t(OUTCOME_COPY[entry.outcome] ?? 'noShow.outcome.closed')}</p>
              ) : null}
              {entry.status === 'awaiting_response' && entry.isOwnReport ? (
                <div className={styles.actions}>
                  <Button variant="ghost" onClick={() => void withdraw(entry.id)} disabled={busy}>
                    {t('noShow.withdraw')}
                  </Button>
                </div>
              ) : null}
            </Card>
          </section>
        );
      })}

      {againstMe && againstMe.status === 'awaiting_response' && !againstMe.responseFiled ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('noShow.yourResponse')}</h2>
          <Card>
            <p className={styles.hint}>{t('noShow.responseHint')}</p>
            <FormField label={t('noShow.whatHappened')} htmlFor="no-show-response-statement">
              <Textarea
                id="no-show-response-statement"
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                maxLength={4000}
              />
            </FormField>
            <div className={styles.actions}>
              <Button onClick={() => void respond(againstMe.id)} disabled={busy}>
                {t('noShow.sendResponse')}
              </Button>
            </div>
          </Card>
        </section>
      ) : null}

      {!ownReport ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('noShow.reportTitle')}</h2>
          <Card>
            <p className={styles.hint}>{t('noShow.reportHint')}</p>
            <FormField label={t('noShow.whatHappened')} htmlFor="no-show-report-statement" optional>
              <Textarea
                id="no-show-report-statement"
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                maxLength={4000}
              />
            </FormField>
            <div className={styles.actions}>
              <Button onClick={() => void report()} disabled={busy}>
                {t('noShow.submit')}
              </Button>
            </div>
          </Card>
        </section>
      ) : null}

      <Link className={styles.eyebrowLink} href={`/bookings/${bookingId}`}>
        {t('noShow.back')}
      </Link>
    </main>
  );
}
