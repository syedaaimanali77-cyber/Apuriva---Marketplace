'use client';

/**
 * Spec 030 §5 "Admin (Trust & Safety)" — the safety queue and its transition form.
 *
 * THE AI SUMMARY IS PRESENTED AS A SUGGESTION, NEVER A VERDICT (AC-4). It sits under an explicit
 * "AI suggestion — not a decision" heading, below the reporter's own words rather than above them,
 * because a screen that led with a machine's paraphrase is the easiest way for a tired admin to
 * stop reading what a person actually wrote.
 *
 * THERE IS NO SANCTION CONTROL HERE (DECIDED-3). The decisions are claim, escalate, resolve and
 * priority, and none of them touches an account. "Request a restriction" hands the request to spec
 * 038 through a port; where spec 038 is not installed the server returns
 * `422 RESTRICTION_UNAVAILABLE` and this screen shows that plainly rather than implying something
 * happened.
 *
 * `expectedStatus` is sent with every decision, so two admins working the queue at once cannot
 * silently overwrite each other.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorState, Select, Skeleton, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import {
  SAFETY_PRIORITIES,
  type AdminSafetyReportDto,
  type SafetyCategory,
  type SafetyPriority,
} from '@/lib/types/safety';
import { MAX_SAFETY_REASON_LENGTH, MIN_SAFETY_REASON_LENGTH } from '@/lib/safety/limits';
import styles from '../../admin.module.css';

const CATEGORY_LABELS: Record<SafetyCategory, string> = {
  harassment: 'Harassment or abusive behaviour',
  threat: 'Threats or intimidation',
  unsafe_behaviour: 'Unsafe behaviour during a job',
  impersonation: 'Impersonation',
  property_damage: 'Property damage',
  other: 'Something else',
};

type Decision = 'claim' | 'escalate' | 'resolve';

const DECISION_LABELS: Record<Decision, string> = {
  claim: 'Start reviewing it',
  escalate: 'Escalate it',
  resolve: 'Close it',
};

export default function AdminSafetyQueuePage() {
  const [reports, setReports] = useState<AdminSafetyReportDto[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminSafetyReportDto | null>(null);
  const [decision, setDecision] = useState<Decision>('claim');
  const [reason, setReason] = useState('');
  const [requestRestriction, setRequestRestriction] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<AdminSafetyReportDto[]>('/api/v1/admin/safety-reports');
    if (!response.ok) {
      setPageError(response.error?.message ?? 'The safety queue could not be loaded.');
      setReports([]);
      return;
    }
    setReports(response.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async () => {
    if (!selected) return;
    const trimmed = reason.trim();
    // Claiming needs no reason; escalating and closing do (master §68).
    if (decision !== 'claim' && (trimmed.length < MIN_SAFETY_REASON_LENGTH || trimmed.length > MAX_SAFETY_REASON_LENGTH)) {
      setFormError(`A reason of ${MIN_SAFETY_REASON_LENGTH}–${MAX_SAFETY_REASON_LENGTH} characters is required.`);
      return;
    }

    setBusy(true);
    setFormError(null);
    const response = await apiFetch<AdminSafetyReportDto>(`/api/v1/admin/safety-reports/${selected.id}/${decision}`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({
        reason: decision === 'claim' ? undefined : trimmed,
        expectedStatus: selected.status,
        ...(decision === 'resolve' ? { requestRestriction } : {}),
      }),
    });
    setBusy(false);

    if (!response.ok) {
      setFormError(response.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }
    setSelected(null);
    setReason('');
    setRequestRestriction(false);
    await load();
  }, [decision, load, reason, requestRestriction, selected]);

  const changePriority = useCallback(
    async (report: AdminSafetyReportDto, priority: SafetyPriority) => {
      const response = await apiFetch<AdminSafetyReportDto>(`/api/v1/admin/safety-reports/${report.id}/priority`, {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify({ priority, expectedStatus: report.status }),
      });
      if (!response.ok) {
        setPageError(response.error?.message ?? 'The priority could not be changed.');
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

  if (pageError) {
    return (
      <main className={styles.page}>
        <ErrorState title="Safety queue unavailable" description={pageError} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Safety reports</h1>
      <p className={styles.subtitle}>
        Open reports, most urgent first and oldest first within each level. Nothing is triaged automatically —
        every priority here was set by a person.
      </p>

      {reports.length === 0 ? (
        <Card>
          <p>Nothing is waiting for review.</p>
        </Card>
      ) : (
        <ul className={styles.list}>
          {reports.map((report) => (
            <li key={report.id}>
              <Card>
                <div>
                  <Badge>{report.status}</Badge>
                  <Badge>{report.priority}</Badge>
                  <span>{CATEGORY_LABELS[report.category] ?? report.category}</span>
                </div>

                {/* The reporter's own words, in full and first. */}
                <p>{report.description}</p>

                {report.aiSummary ? (
                  <section aria-label="AI suggestion — not a decision">
                    <h3>AI suggestion — not a decision</h3>
                    <p>{report.aiSummary}</p>
                  </section>
                ) : null}

                {report.restrictionRequestedAt ? (
                  <p>A restriction was requested for this account on {report.restrictionRequestedAt}.</p>
                ) : null}

                <label htmlFor={`priority-${report.id}`}>Priority</label>
                <Select
                  id={`priority-${report.id}`}
                  value={report.priority}
                  options={SAFETY_PRIORITIES.map((value) => ({ value, label: value }))}
                  onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                    void changePriority(report, event.target.value as SafetyPriority)
                  }
                />

                <Button
                  onClick={() => {
                    setSelected(report);
                    setDecision(report.status === 'submitted' ? 'claim' : 'resolve');
                    setReason('');
                    setRequestRestriction(false);
                    setFormError(null);
                  }}
                >
                  Action
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <Card>
          <h2 className={styles.sectionTitle}>Action this report</h2>

          <label htmlFor="safety-decision">Decision</label>
          <Select
            id="safety-decision"
            value={decision}
            options={(['claim', 'escalate', 'resolve'] as Decision[]).map((value) => ({
              value,
              label: DECISION_LABELS[value],
            }))}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setDecision(event.target.value as Decision)}
            disabled={busy}
          />

          <label htmlFor="safety-reason">Reason (recorded in the audit log)</label>
          <Textarea
            id="safety-reason"
            value={reason}
            maxLength={MAX_SAFETY_REASON_LENGTH}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
            disabled={busy}
          />

          {decision === 'resolve' ? (
            <label>
              <input
                type="checkbox"
                checked={requestRestriction}
                onChange={(event) => setRequestRestriction(event.target.checked)}
                disabled={busy}
              />{' '}
              Also ask for this account to be restricted
            </label>
          ) : null}

          {formError ? <p role="alert">{formError}</p> : null}

          <div className={styles.actions}>
            <Button onClick={act} disabled={busy}>
              {busy ? 'Saving…' : 'Save decision'}
            </Button>
            <Button variant="secondary" onClick={() => setSelected(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}
    </main>
  );
}
