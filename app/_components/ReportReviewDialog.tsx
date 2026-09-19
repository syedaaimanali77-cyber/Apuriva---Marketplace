'use client';

/**
 * Spec 029 §5 — the report-a-review dialog (AC-6).
 *
 * Built on the existing `ConfirmDialog` plus `Select` and `Textarea`; no new overlay primitive is
 * created. The reason list is spec 029's closed set, rendered in the same order the API validates.
 *
 * THE COPY IS DELIBERATE. It tells the reporter that a human will look and that nothing disappears
 * in the meantime, because that is true (AC-4/AC-6) and because a reporting flow that implies
 * "report = takedown" trains people to report reviews they merely disagree with. Reporting the same
 * review twice returns the reporter's own existing report, so the UI can say "already reported"
 * without a special error path.
 */
import { useState } from 'react';
import { ConfirmDialog, Select, Textarea } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import { REVIEW_REPORT_REASONS, type ReviewReportDto, type ReviewReportReason } from '@/lib/types/reviews';
import { MAX_TEXT_LENGTH, MIN_TEXT_LENGTH } from '@/lib/reviews/limits';

const REASON_LABELS: Record<ReviewReportReason, string> = {
  spam: 'Spam or advertising',
  offensive: 'Offensive or abusive language',
  false_information: 'Untrue account of what happened',
  personal_information: 'Contains someone’s personal information',
  off_topic: 'Not about this service',
  other: 'Something else',
};

export interface ReportReviewDialogProps {
  reviewId: string;
  open: boolean;
  onClose: () => void;
  onReported?: (report: ReviewReportDto) => void;
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ReportReviewDialog({ reviewId, open, onClose, onReported }: ReportReviewDialogProps) {
  const [reason, setReason] = useState<ReviewReportReason>('spam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = details.trim();
    if (reason === 'other' && trimmed.length < MIN_TEXT_LENGTH) {
      setError(`Please describe the problem in at least ${MIN_TEXT_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    setError(null);
    const response = await apiFetch<ReviewReportDto>(`/api/v1/reviews/${reviewId}/reports`, {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': newIdempotencyKey() }),
      body: JSON.stringify({ reason, details: trimmed.length > 0 ? trimmed : null }),
    });
    setBusy(false);

    if (!response.ok) {
      setError(response.error?.message ?? "Something went wrong. Please try again.");
      return;
    }
    onReported?.(response.data!);
    onClose();
  };

  if (!open) return null;

  return (
    <ConfirmDialog
      open={open}
      title="Report this review"
      confirmLabel={busy ? 'Sending…' : 'Send report'}
      cancelLabel="Cancel"
      tone="primary"
      pending={busy}
      onConfirm={submit}
      onCancel={onClose}
      // `ConfirmDialog` takes its body as `description: ReactNode`, not as children — reused as it
      // is rather than widened, since this spec adds no overlay primitive.
      description={
        <>
      <p>
        Trust &amp; Safety will read this review and decide. It stays visible in the meantime — reporting does not
        remove anything on its own.
      </p>

      <label htmlFor="report-reason">Why are you reporting it?</label>
      <Select
        id="report-reason"
        value={reason}
        options={REVIEW_REPORT_REASONS.map((value) => ({ value, label: REASON_LABELS[value] }))}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setReason(event.target.value as ReviewReportReason)}
        disabled={busy}
      />

      <label htmlFor="report-details">{reason === 'other' ? 'Tell us what is wrong' : 'Anything to add? (optional)'}</label>
      <Textarea
        id="report-details"
        value={details}
        maxLength={MAX_TEXT_LENGTH}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDetails(event.target.value)}
        disabled={busy}
      />

      {error ? <p role="alert">{error}</p> : null}
        </>
      }
    />
  );
}
