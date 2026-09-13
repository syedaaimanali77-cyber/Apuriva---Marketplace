'use client';

import { Badge } from '@/components';
import type { AvailabilitySummaryDto } from '@/lib/types/availability';
import styles from '../schedule.module.css';

const TONE_BY_STATE = {
  available: 'success',
  busy: 'warning',
  unavailable: 'neutral',
} as const;

const LABEL_BY_STATE = {
  available: 'Available',
  busy: 'Busy',
  unavailable: 'Unavailable',
} as const;

export interface AvailabilityBadgeProps {
  summary: AvailabilitySummaryDto;
  /** Rendered disabled with the reason as their accessible description (AC-5). */
  actions?: { label: string }[];
}

/**
 * Spec 016 §5 / AC-5 — the customer-facing availability state, ALWAYS paired with its reason as
 * visible text. Master spec §3.5 forbids conveying status by colour alone, so the `Badge` tone is
 * decoration: the state word and the reason sentence carry the meaning on their own.
 *
 * An unavailable provider stays discoverable — this component renders normally and only disables
 * the booking/offer actions, each describing itself with the same reason.
 */
export function AvailabilityBadge({ summary, actions = [] }: AvailabilityBadgeProps) {
  const bookable = summary.state === 'available';
  const reasonId = 'availability-reason';

  return (
    <div className={styles.availability}>
      <div className={styles.availabilityHeader}>
        <Badge tone={TONE_BY_STATE[summary.state]}>{LABEL_BY_STATE[summary.state]}</Badge>
        <p className={styles.availabilityReason} id={reasonId}>
          {summary.reason}
        </p>
      </div>

      {summary.nextAvailableDate && !bookable ? (
        <p className={styles.availabilityNext}>Next available {summary.nextAvailableDate}</p>
      ) : null}

      {actions.length > 0 ? (
        <div className={styles.availabilityActions}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={styles.availabilityAction}
              disabled={!bookable}
              aria-describedby={bookable ? undefined : reasonId}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
