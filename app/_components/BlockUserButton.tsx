'use client';

/**
 * Spec 030 §5 (AC-1) — the block affordance.
 *
 * Mounted where spec 025 already exposes a counterparty's user id
 * (`ConversationParticipantDto.userId`). It is NOT mounted on a booking screen: spec 020's DTOs
 * deliberately carry no counterparty `users.id`, and this spec does not widen them to get one.
 *
 * THE CONFIRMATION TELLS THE TRUTH ABOUT WHAT A BLOCK DOES AND DOES NOT DO. It stops future
 * messages and future matching; it does not cancel a booking, does not delete message history, and
 * does not tell the other person. Someone protecting themselves needs to know all three before
 * they act — particularly that a job already booked still stands.
 */
import { useCallback, useState } from 'react';
import { Button, ConfirmDialog } from '@/components';
import { apiFetch, mutateHeaders } from '@/app/requests/api-client';
import type { BlockDto } from '@/lib/types/safety';
import { useLocale } from './LocaleProvider';

export interface BlockUserButtonProps {
  targetUserId: string;
  /** Rendered after a successful block, so the host can refresh its own state. */
  onBlocked?: (block: BlockDto) => void;
}

export function BlockUserButton({ targetUserId, onBlocked }: BlockUserButtonProps) {
  const { t, errorText } = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    const response = await apiFetch<BlockDto>('/api/v1/blocks', {
      method: 'POST',
      headers: mutateHeaders({ 'idempotency-key': crypto.randomUUID() }),
      body: JSON.stringify({ targetUserId }),
    });
    setBusy(false);

    if (!response.ok) {
      setError(errorText(response.error?.code, response.error?.message, t('shared.block.failed')));
      return;
    }
    setBlocked(true);
    setOpen(false);
    if (response.data) onBlocked?.(response.data);
  }, [errorText, onBlocked, t, targetUserId]);

  if (blocked) return <p role="status">{t('shared.block.done')}</p>;

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('shared.block.button')}
      </Button>
      <ConfirmDialog
          open={open}
          title={t('shared.block.title')}
          description={t('shared.block.description')}
          confirmLabel={busy ? t('shared.block.blocking') : t('shared.block.confirm')}
          pending={busy}
          onConfirm={() => void confirm()}
          onCancel={() => setOpen(false)}
        />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
