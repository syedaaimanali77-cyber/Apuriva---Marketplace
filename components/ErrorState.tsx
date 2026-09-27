'use client';

import { ErrorState as DsErrorState, type ErrorStateProps } from '@/ui/components/feedback/ErrorState';
import { useLocale } from '@/app/_components/LocaleProvider';

export type { ErrorStateProps };

/** Spec 042 X-2 (§5.2) — the DS `ErrorState` with its title and retry label defaulted from `t()`. */
export function ErrorState({ title, retryLabel, ...props }: ErrorStateProps) {
  const { t } = useLocale();
  return <DsErrorState title={title ?? t('common.somethingWentWrong')} retryLabel={retryLabel ?? t('common.tryAgain')} {...props} />;
}
