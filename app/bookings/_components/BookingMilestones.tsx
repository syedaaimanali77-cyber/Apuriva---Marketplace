'use client';

/**
 * Spec 028 §5 — the milestone list, and (for the provider, mid-job) the control that posts one.
 *
 * Shared by both booking screens so the two never drift. It adds no page, no `ui/` primitive and no
 * design token: everything here composes `@/components` primitives that already exist and the
 * existing `bookings.module.css`. Per CLAUDE.md's branding rule it carries no logo of its own — the
 * pages that embed it already have their brand placement.
 *
 * TWO RULES THIS COMPONENT EXISTS TO RESPECT:
 *   - Milestones are OPTIONAL (AC-3). The poster is visibly optional and nothing here gates the
 *     completion control on it.
 *   - The customer's EMPTY state is nothing at all — no list, no "no updates yet" placeholder. A
 *     provider who posts nothing must not look like a provider who is failing to report.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Select, Textarea } from '@/components';
import type { BookingMilestoneDto, BookingMilestoneType, BookingStatus } from '@/lib/types/bookings';
import { apiFetch, formatScheduled, mutateHeaders } from '@/app/bookings/booking-client';
import styles from '@/app/bookings/bookings.module.css';

/** Mirrors `EXECUTING_BOOKING_STATUSES` — the server remains authoritative. */
const POSTABLE_STATUSES: readonly BookingStatus[] = ['arrived', 'in_progress'];

const MILESTONE_LABELS: Record<BookingMilestoneType, string> = {
  started: 'Started',
  working: 'Working on it',
  almost_done: 'Almost done',
  custom: 'Custom update',
};

export interface BookingMilestonesProps {
  bookingId: string;
  status: BookingStatus;
  scheduledTimezone: string;
  viewerRole: 'customer' | 'provider';
}

export function BookingMilestones({ bookingId, status, scheduledTimezone, viewerRole }: BookingMilestonesProps) {
  const [milestones, setMilestones] = useState<BookingMilestoneDto[]>([]);
  const [milestoneType, setMilestoneType] = useState<BookingMilestoneType>('working');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<BookingMilestoneDto[]>(`/api/v1/bookings/${bookingId}/milestones`);
      // Defensive: only ever hold a list, so a malformed response cannot throw inside render.
      setMilestones(result.ok && Array.isArray(result.data) ? result.data : []);
    } catch {
      // A dropped connection leaves the section empty rather than rejecting unhandled. Progress
      // updates are an optional embellishment; losing them must never break the booking screen.
      setMilestones([]);
    }
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canPost = viewerRole === 'provider' && POSTABLE_STATUSES.includes(status);

  const post = useCallback(async () => {
    setPending(true);
    setError(null);
    const result = await apiFetch<BookingMilestoneDto>(`/api/v1/bookings/${bookingId}/milestones`, {
      method: 'POST',
      // A fresh key per submission: this is a new update, not a retry of the previous one.
      headers: mutateHeaders({ 'Idempotency-Key': crypto.randomUUID() }),
      body: JSON.stringify({ milestoneType, note: note.trim() === '' ? undefined : note.trim() }),
    });
    setPending(false);

    if (!result.ok) {
      setError(result.error?.message ?? 'That update did not go through.');
      return;
    }
    setNote('');
    await load();
  }, [bookingId, milestoneType, note, load]);

  // The customer's empty state is deliberately nothing at all (§5).
  if (milestones.length === 0 && !canPost) return null;

  return (
    <Card>
      <h2 className={styles.sectionTitle}>Progress updates</h2>

      {milestones.length > 0 && (
        <ul className={styles.historyList}>
          {milestones.map((milestone) => (
            <li key={milestone.id} className={styles.historyRow}>
              <span>
                {MILESTONE_LABELS[milestone.milestoneType]}
                {milestone.note ? ` — ${milestone.note}` : ''}
              </span>
              <span className={styles.historyActor}>{formatScheduled(milestone.createdAt, scheduledTimezone)}</span>
            </li>
          ))}
        </ul>
      )}

      {canPost && (
        <div className={styles.actions}>
          <Select
            aria-label="Progress update"
            value={milestoneType}
            options={(Object.keys(MILESTONE_LABELS) as BookingMilestoneType[]).map((type) => ({
              value: type,
              label: MILESTONE_LABELS[type],
            }))}
            onChange={(event) => setMilestoneType(event.target.value as BookingMilestoneType)}
          />
          <Textarea
            aria-label={milestoneType === 'custom' ? 'What should the customer know?' : 'Add a note (optional)'}
            placeholder={milestoneType === 'custom' ? 'What should the customer know?' : 'Add a note (optional)'}
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button variant="secondary" loading={pending} onClick={() => void post()}>
            Post update
          </Button>
        </div>
      )}

      {canPost && (
        // AC-3, stated plainly on the screen it applies to.
        <p className={styles.hint}>
          Progress updates are optional. You can finish this job without posting any.
        </p>
      )}

      {error && <Alert tone="error">{error}</Alert>}
    </Card>
  );
}
