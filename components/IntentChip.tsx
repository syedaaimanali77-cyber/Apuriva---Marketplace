'use client';

import { Icon } from '@/ui/components/core/Icon.jsx';

export interface IntentChipProps {
  label: string;
  onRemove: () => void;
}

/**
 * Spec 013 §5 — one interpreted filter, shown as a removable chip so the customer can see (and
 * discard) exactly what the AI understood before results render (AC-1, master spec §84: AI
 * suggestions are clearly labeled, never presented as system facts). Named by spec 013, no
 * `ui/` implementation exists — built directly in `components/`, the same pattern as
 * `ConfirmDialog`/`PriceDisplay`.
 */
export function IntentChip({ label, onRemove }: IntentChipProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '4px 8px 4px 12px',
        borderRadius: 'var(--radius-pill)',
        background: 'var(--surface-brand-subtle)',
        color: 'var(--text-brand)',
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--weight-semibold)',
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
          width: 20,
          height: 20,
          border: 'none',
          borderRadius: 'var(--radius-circle)',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <Icon name="x" size="xs" />
      </button>
    </span>
  );
}
