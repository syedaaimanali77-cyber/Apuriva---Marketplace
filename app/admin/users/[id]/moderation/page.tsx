'use client';

/**
 * Spec 038 §5 — one account's moderation history, the new-action form, evidence upload, and the
 * apply/reverse controls for approved actions.
 *
 * EVERY ACTION GOES THROUGH A STRUCTURED CONFIRMATION with a mandatory reason (master §90): a ban is
 * never one click. High/critical actions land "Awaiting second admin" — the approval itself happens
 * on spec 009's existing /admin/approvals screen, and "Apply approved action" becomes available only
 * after it. The server is authoritative for every rule shown here; the UI only explains them.
 *
 * Evidence is uploaded through spec 027's `FileUpload` into the private `moderation_evidence` context
 * of an action that exists — there is no separate evidence component.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, FormField, Input, Select, Skeleton, Table, Textarea } from '@/components';
import { FileUpload } from '@/app/_components/FileUpload';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { ModerationActionDetailDto, ModerationActionDto, ModerationActionType, ModerationScope } from '@/lib/types/moderation';
import styles from '../../../admin.module.css';

const ACTION_LABELS: Record<ModerationActionType, string> = {
  warning: 'Warning',
  restriction: 'Restriction',
  suspension: 'Suspension (needs a second admin)',
  ban: 'Ban (needs a second admin)',
  booking_intervention: 'Booking intervention (needs a second admin)',
  payout_freeze: 'Payout freeze (needs a second admin)',
};

const SCOPES_FOR: Record<ModerationActionType, ModerationScope[]> = {
  warning: ['account', 'provider_profile'],
  restriction: ['account', 'provider_profile'],
  suspension: ['account', 'provider_profile'],
  ban: ['account', 'provider_profile'],
  booking_intervention: ['booking'],
  payout_freeze: ['provider_profile'],
};

const STATUS_TONE: Record<string, 'neutral' | 'warning' | 'error' | 'success' | 'info'> = {
  pending_approval: 'warning',
  active: 'error',
  executed: 'info',
  superseded: 'neutral',
  reversed: 'success',
  rejected: 'neutral',
};

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export default function AdminUserModerationPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const userId = params?.id ?? '';
  const originFraudSignalId = searchParams?.get('signal') ?? undefined;

  const [actions, setActions] = useState<ModerationActionDto[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModerationActionDetailDto | null>(null);

  const [actionType, setActionType] = useState<ModerationActionType>('warning');
  const [scope, setScope] = useState<ModerationScope>('account');
  const [providerProfileId, setProviderProfileId] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [refundTreatment, setRefundTreatment] = useState<'policy' | 'full'>('policy');
  const [reason, setReason] = useState('');
  const [userMessage, setUserMessage] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reversalReason, setReversalReason] = useState('');

  const load = useCallback(async () => {
    const response = await apiFetch<ModerationActionDto[]>(`/api/v1/admin/moderation-actions?targetUserId=${encodeURIComponent(userId)}`);
    if (!response.ok) {
      setPageError(response.error?.message ?? 'Moderation history could not be loaded.');
      setActions([]);
      return;
    }
    setActions(response.data ?? []);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    const response = await apiFetch<ModerationActionDetailDto>(`/api/v1/admin/moderation-actions/${id}`);
    if (response.ok && response.data) setSelected(response.data);
    else setFormError(response.error?.message ?? 'That action could not be loaded.');
  }, []);

  const scopes = SCOPES_FOR[actionType];
  useEffect(() => {
    if (!scopes.includes(scope)) setScope(scopes[0]!);
  }, [scope, scopes]);

  const submit = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    const response = await apiFetch<ModerationActionDto>('/api/v1/admin/moderation-actions', {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify({
        actionType,
        scope,
        targetUserId: userId,
        providerProfileId: scope === 'provider_profile' ? providerProfileId.trim() : undefined,
        bookingId: scope === 'booking' ? bookingId.trim() : undefined,
        refundTreatment: actionType === 'booking_intervention' ? refundTreatment : undefined,
        reason: reason.trim(),
        userMessage: userMessage.trim() || undefined,
        originFraudSignalId,
      }),
    });
    setBusy(false);
    setConfirming(false);
    if (!response.ok || !response.data) {
      // Error state: the entered reason, message and fields are preserved.
      setFormError(response.error?.message ?? 'The action could not be saved.');
      return;
    }
    setNotice(
      response.data.status === 'pending_approval'
        ? 'Saved. It is awaiting a second admin on the approvals screen and has no effect yet.'
        : 'Saved and in effect.',
    );
    setReason('');
    setUserMessage('');
    setIdempotencyKey(newKey());
    await load();
    await openDetail(response.data.id);
  }, [actionType, bookingId, idempotencyKey, load, openDetail, originFraudSignalId, providerProfileId, reason, refundTreatment, scope, userId, userMessage]);

  const post = useCallback(
    async (url: string, body?: unknown, success?: string) => {
      if (!selected) return;
      setBusy(true);
      setFormError(null);
      const response = await apiFetch<ModerationActionDto>(url, {
        method: 'POST',
        headers: mutateHeaders({ 'Idempotency-Key': newKey() }),
        body: JSON.stringify(body ?? {}),
      });
      setBusy(false);
      if (!response.ok) {
        setFormError(response.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      setNotice(success ?? 'Done.');
      await load();
      await openDetail(selected.id);
    },
    [load, openDetail, selected],
  );

  const columns = useMemo(
    () => [
      { key: 'actionType', header: 'Action', render: (row: ModerationActionDto) => row.actionType },
      { key: 'scope', header: 'Scope', render: (row: ModerationActionDto) => row.scope },
      {
        key: 'status',
        header: 'Status',
        render: (row: ModerationActionDto) => <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>,
      },
      { key: 'riskTier', header: 'Risk', render: (row: ModerationActionDto) => row.riskTier },
      { key: 'createdAt', header: 'Created', render: (row: ModerationActionDto) => new Date(row.createdAt).toLocaleString() },
      {
        key: 'open',
        header: <span className={styles.visuallyHidden}>Open</span>,
        render: (row: ModerationActionDto) => (
          <Button size="sm" variant="secondary" onClick={() => void openDetail(row.id)}>
            Open
          </Button>
        ),
      },
    ],
    [openDetail],
  );

  if (actions === null) {
    return (
      <main className={styles.page} data-density="dense">
        <Skeleton />
      </main>
    );
  }

  if (pageError) {
    return (
      <main className={styles.page} data-density="dense">
        <ErrorState title="Moderation unavailable" description={pageError} />
      </main>
    );
  }

  const reasonMissing = reason.trim().length === 0;

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Account moderation</h1>

      {notice ? (
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}

      <section aria-labelledby="history-heading" className={styles.section}>
        <h2 id="history-heading" className={styles.sectionTitle}>
          History
        </h2>
        <Table columns={columns} rows={actions} caption="Moderation actions for this account" emptyMessage="No moderation actions yet." />
      </section>

      {selected ? (
        <Card>
          <section aria-labelledby="detail-heading" className={styles.section}>
            <h2 id="detail-heading" className={styles.sectionTitle}>
              {selected.actionType} — <Badge tone={STATUS_TONE[selected.status] ?? 'neutral'}>{selected.status}</Badge>
            </h2>
            <p className={styles.sectionDescription}>Reason (internal): {selected.reason}</p>
            {selected.appeal ? <p className={styles.sectionDescription}>Appeal: {selected.appeal.status}</p> : null}
            <p className={styles.sectionDescription}>Evidence files: {selected.evidenceFileAssetIds.length}</p>

            {selected.status === 'pending_approval' || selected.status === 'active' ? (
              <FileUpload contextType="moderation_evidence" contextId={selected.id} label="Attach private evidence" />
            ) : null}

            {selected.status === 'pending_approval' ? (
              <div className={styles.actions}>
                <Link href="/admin/approvals">Go to approvals</Link>
                <Button onClick={() => void post(`/api/v1/admin/moderation-actions/${selected.id}/execute`, {}, 'Applied.')} disabled={busy}>
                  Apply approved action
                </Button>
              </div>
            ) : null}

            {selected.status === 'active' && selected.actionType !== 'booking_intervention' ? (
              <div className={styles.form}>
                <div className={styles.formField}>
                  <FormField label="Reversal reason" htmlFor="reversal-reason" required>
                    <Textarea
                      id="reversal-reason"
                      value={reversalReason}
                      maxLength={500}
                      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReversalReason(event.target.value)}
                    />
                  </FormField>
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    disabled={busy || reversalReason.trim().length === 0}
                    onClick={() =>
                      void post(
                        `/api/v1/admin/moderation-actions/${selected.id}/reverse`,
                        { reason: reversalReason.trim() },
                        'Reversal requested. It needs a second admin before it takes effect.',
                      )
                    }
                  >
                    Request reversal
                  </Button>
                  {selected.reversalAdminActionId ? (
                    <Button
                      disabled={busy}
                      onClick={() => void post(`/api/v1/admin/moderation-actions/${selected.id}/reverse/execute`, {}, 'Reversed.')}
                    >
                      Apply approved reversal
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        </Card>
      ) : null}

      <Card>
        <section aria-labelledby="new-action-heading" className={styles.section}>
          <h2 id="new-action-heading" className={styles.sectionTitle}>
            New moderation action
          </h2>
          {originFraudSignalId ? <p className={styles.sectionDescription}>Acting on fraud signal {originFraudSignalId}.</p> : null}

          <div className={styles.form}>
            <div className={styles.formField}>
              <FormField label="Action" htmlFor="moderation-action-type">
                <Select
                  id="moderation-action-type"
                  value={actionType}
                  options={(Object.keys(ACTION_LABELS) as ModerationActionType[]).map((value) => ({ value, label: ACTION_LABELS[value] }))}
                  onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setActionType(event.target.value as ModerationActionType)}
                  disabled={busy}
                />
              </FormField>
            </div>
            <div className={styles.formField}>
              <FormField label="Applies to" htmlFor="moderation-scope">
                <Select
                  id="moderation-scope"
                  value={scope}
                  options={scopes.map((value) => ({ value, label: value.replace('_', ' ') }))}
                  onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setScope(event.target.value as ModerationScope)}
                  disabled={busy}
                />
              </FormField>
            </div>
            {scope === 'provider_profile' ? (
              <div className={styles.formField}>
                <FormField label="Provider profile id" htmlFor="moderation-provider-profile" required>
                  <Input
                    id="moderation-provider-profile"
                    value={providerProfileId}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setProviderProfileId(event.target.value)}
                  />
                </FormField>
              </div>
            ) : null}
            {scope === 'booking' ? (
              <>
                <div className={styles.formField}>
                  <FormField label="Booking id" htmlFor="moderation-booking" required>
                    <Input
                      id="moderation-booking"
                      value={bookingId}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => setBookingId(event.target.value)}
                    />
                  </FormField>
                </div>
                <div className={styles.formField}>
                  <FormField label="Refund" htmlFor="moderation-refund">
                    <Select
                      id="moderation-refund"
                      value={refundTreatment}
                      options={[
                        { value: 'policy', label: 'Apply the cancellation policy' },
                        { value: 'full', label: 'Full refund to the customer' },
                      ]}
                      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setRefundTreatment(event.target.value as 'policy' | 'full')}
                    />
                  </FormField>
                </div>
              </>
            ) : null}
          </div>

          <FormField label="Reason (internal, recorded in the audit log)" htmlFor="moderation-reason" required>
            <Textarea
              id="moderation-reason"
              value={reason}
              maxLength={500}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
              disabled={busy}
            />
          </FormField>
          <FormField label="Message to the user" htmlFor="moderation-user-message" optional>
            <Textarea
              id="moderation-user-message"
              value={userMessage}
              maxLength={500}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setUserMessage(event.target.value)}
              disabled={busy}
            />
          </FormField>

          {formError ? (
            <Alert tone="error" title="Not saved">
              {formError}
            </Alert>
          ) : null}

          <div className={styles.actions}>
            <Button variant="danger" disabled={busy || reasonMissing} onClick={() => setConfirming(true)}>
              Review and confirm
            </Button>
          </div>
        </section>
      </Card>

      <ConfirmDialog
        open={confirming}
        title={`Confirm: ${ACTION_LABELS[actionType]}`}
        description={
          <>
            This will record a {actionType.replace('_', ' ')} against this {scope.replace('_', ' ')} with your reason. Actions that
            need a second admin take no effect until approved and applied.
          </>
        }
        confirmLabel="Confirm action"
        pending={busy}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      />
    </main>
  );
}
