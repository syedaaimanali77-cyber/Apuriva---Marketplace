'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/ui/components/core/Button.jsx';
import { Icon } from '@/ui/components/core/Icon.jsx';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` (default) for a destructive action (deletion, logout-all) — spec 008 §5. */
  tone?: 'danger' | 'primary';
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR = 'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Spec 002 names `Dialog`/`ConfirmDialog` but ships no implementation in `ui/` (see
 * components/index.ts) — this is spec 008's own, built from existing tokens the same way
 * app/account/_components/AccountMenu.tsx builds its dropdown. A destructive confirmation
 * (deletion, "log out all devices") per spec 008 §5: explicit confirmation, consequence stated
 * plainly, fully keyboard operable, with the one focus trap this UI intentionally has.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    (focusable?.[focusable.length - 1] ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!pending) onCancel();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [open, pending, onCancel]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-dialog)',
        background: 'var(--surface-overlay-scrim)',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--space-4)',
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? 'confirm-dialog-description' : undefined}
        tabIndex={-1}
        style={{
          width: '100%',
          maxWidth: 420,
          display: 'grid',
          gap: 'var(--space-4)',
          padding: 'var(--space-6)',
          background: 'var(--surface-card)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          <span
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 'var(--radius-circle)',
              background: tone === 'danger' ? 'var(--status-error-bg)' : 'var(--surface-brand-subtle)',
            }}
          >
            <Icon
              name={tone === 'danger' ? 'triangle-alert' : 'info'}
              color={tone === 'danger' ? 'var(--status-error-fg)' : 'var(--teal-600)'}
            />
          </span>
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <h2 id="confirm-dialog-title" style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>
              {title}
            </h2>
            {description ? (
              <p id="confirm-dialog-description" style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)' }}>
                {description}
              </p>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
