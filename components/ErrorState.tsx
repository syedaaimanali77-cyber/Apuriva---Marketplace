'use client';

import { ErrorState as DsErrorState, type ErrorStateProps } from '@/ui/components/feedback/ErrorState';
import { useLocale } from '@/app/_components/LocaleProvider';

export type { ErrorStateProps };

/**
 * Spec 042 X-2 (§5.2) — the DS `ErrorState` with its title and retry label defaulted from `t()`. With no
 * dictionary loaded at all (`global-error` before its lazy dictionaries arrive, §3.5), `t()` is empty and
 * the DS's own English defaults show instead, so the heading and retry button are never blank.
 */
export function ErrorState({ title, retryLabel, ...props }: ErrorStateProps) {
  const { t } = useLocale();
  return (
    <DsErrorState
      title={title ?? (t('common.somethingWentWrong') || undefined)}
      retryLabel={retryLabel ?? (t('common.tryAgain') || undefined)}
      {...props}
    />
  );;
}
