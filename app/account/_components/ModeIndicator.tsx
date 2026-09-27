import { Badge } from '@/components';
import type { ActiveMode } from '@/lib/types/users';

const MODE_COPY: Record<ActiveMode, { label: string; icon: string; tone: 'brand' | 'accent' }> = {
  customer: { label: 'Customer Mode', icon: 'user', tone: 'brand' },
  provider: { label: 'Service Provider Mode', icon: 'briefcase', tone: 'accent' },
};

/** Spec 006 §5 — the persistent indicator of the CURRENT SESSION's active mode (never a global
 * user preference; see spec 006 §4). Purely presentational. */
export function ModeIndicator({ mode }: { mode: ActiveMode }) {
  const copy = MODE_COPY[mode];
  return (
    <Badge tone={copy.tone} icon={copy.icon}>
      {copy.label}
    </Badge>
  );
}
