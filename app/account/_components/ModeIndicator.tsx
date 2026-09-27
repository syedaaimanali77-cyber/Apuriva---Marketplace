'use client';

import { Badge } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import type { ActiveMode } from '@/lib/types/users';

const MODE_COPY: Record<ActiveMode, { label: MessageKey; icon: string; tone: 'brand' | 'accent' }> = {
  customer: { label: 'chrome.mode.customer', icon: 'user', tone: 'brand' },
  provider: { label: 'chrome.mode.provider', icon: 'briefcase', tone: 'accent' },
};

/** Spec 006 §5 — the persistent indicator of the CURRENT SESSION's active mode (never a global
 * user preference; see spec 006 §4). Purely presentational. */
export function ModeIndicator({ mode }: { mode: ActiveMode }) {
  const { t } = useLocale();
  const copy = MODE_COPY[mode];
  return (
    <Badge tone={copy.tone} icon={copy.icon}>
      {t(copy.label)}
    </Badge>
  );
}
