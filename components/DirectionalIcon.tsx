'use client';

import { Icon, type IconProps } from '@/ui/components/core/Icon';

/** The DS icon set's only directional glyphs (spec 042 §5.2). `chevron-down` is not one. */
export const DIRECTIONAL_ICON_NAMES = ['arrow-right', 'chevron-right'] as const;

/**
 * Spec 042 §5.2 (X-2) — an `Icon` that mirrors right-to-left through `--rtl-flip` (`app/globals.css`
 * sets it to `scaleX(-1)` under `[dir='rtl']`), the same mechanism the DS `ListRow`/`EmptyState` use.
 * A thin wrapper so `ui/` is never edited.
 */
export function DirectionalIcon({ style, ...props }: IconProps) {
  return <Icon {...props} style={{ ...style, transform: 'var(--rtl-flip, none)' }} />;
}
