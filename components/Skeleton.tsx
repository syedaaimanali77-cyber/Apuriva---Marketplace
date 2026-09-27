'use client';

import { Skeleton as DsSkeleton, type SkeletonProps } from '@/ui/components/core/Skeleton';
import { useLocale } from '@/app/_components/LocaleProvider';

export type { SkeletonProps };

/**
 * Spec 042 X-2 (§5.2) — the DS `Skeleton`, whose built-in status text is a fixed English "Loading" with no
 * prop (and `ui/` is never edited). Under `en` it renders unchanged. Under any other locale the announced
 * status is this wrapper's translated label, and the DS bars — its English text included — sit in an
 * `aria-hidden` subtree, so assistive technology hears one status in the user's language.
 */
export function Skeleton(props: SkeletonProps) {
  const { locale, t } = useLocale();
  if (locale === 'en') return <DsSkeleton {...props} />;
  return (
    <span role="status" aria-live="polite" aria-busy="true" style={{ display: 'block' }}>
      <span className="apr-visually-hidden">{t('common.loading')}</span>
      <span aria-hidden="true" style={{ display: 'block' }}>
        <DsSkeleton {...props} />
      </span>
    </span>
  );
}
