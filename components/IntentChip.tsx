'use client';

import { Icon } from '@/ui/components/core/Icon.jsx';

export interface IntentChipProps {
  label: string;
  onRemove: () => void;
}

/**
 * Spec 013 §5 — one interpreted filter, shown as a removable chip so the customer can see (and
 * discard) exactly what the AI understood before results render (AC-1, master spec §84: AI
 * suggestions are clearly labeled, never presented as system facts).
 *
 * Visually this is the DS `Tag` (ui/components/core/Tag) in its selected state. It isn't the
 * `Tag` itself because `Tag`'s remove affordance is a `<span role="button">` with a generic
 * "Remove" label and no keyboard activation; this chip needs a real, specifically-labelled button.
 */
export function IntentChip({ label, onRemove }: IntentChipProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        height: 30,
        paddingInlineStart: 12,
        paddingInlineEnd: 4,
        borderRadius: 'var(--radius-pill)',
        border: '1px solid var(--border-brand)',
        background: 'var(--surface-brand-subtle)',
        color: 'var(--text-brand)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--weight-medium)',
      }}
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove "${label}" filter`}
        style={{
          display: 'grid',
          placeItems: 'center',
          width: 22,
          height: 22,
          padding: 0,
          border: 'none',
          borderRadius: 'var(--radius-circle)',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <Icon name="x" size={13} strokeWidth={2.2} />
      </button>
    </span>
  );
}
