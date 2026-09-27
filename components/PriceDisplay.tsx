'use client';

import { useLocale } from '@/app/_components/LocaleProvider';
import { formatMoney } from '@/lib/i18n/format';
import type { PriceDisplay as PriceDisplayValue } from '@/lib/types/service-page';

/**
 * Spec 011 §5/AC-2 — pricing-model-aware price display, built from existing tokens (same
 * app-facing-primitive pattern as `components/ConfirmDialog.tsx`, not a `ui/` design-system
 * component). Maps `priceDisplay.type` to its label: `exact` → the price, `starting` → "From",
 * `range` → "From ... (custom pricing)", `quote` → "Get offers", `hourly` → "/hr".
 *
 * Spec 042 X-11/X-12: money through the shared `formatMoney` for the reader's locale (the value's own
 * currency and its real fraction digits — the old helper divided by 100 for every currency), and the
 * labels through `t()`. English output is unchanged (`en` formats exactly as the old pinned `en-US`).
 */
export function PriceDisplay({ priceDisplay }: { priceDisplay: PriceDisplayValue }) {
  const { locale, t } = useLocale();
  const { type, amountMinorUnits, currencyCode } = priceDisplay;
  const amount = amountMinorUnits !== undefined && currencyCode !== undefined ? formatMoney(amountMinorUnits, currencyCode, locale) : null;

  let label: string;
  switch (type) {
    case 'exact':
      label = amount ?? t('price.toBeConfirmed');
      break;
    case 'starting':
      label = amount ? t('price.from', { amount }) : t('price.startingToBeConfirmed');
      break;
    case 'range':
      label = amount ? t('price.fromCustom', { amount }) : t('price.custom');
      break;
    case 'hourly':
      label = amount ? t('price.hourly', { amount }) : t('price.hourlyToBeConfirmed');
      break;
    case 'quote':
    default:
      label = t('price.getOffers');
      break;
  }

  return (
    // DS money/figures: display face, tabular numerals, `--text-price`.
    <span
      data-price-display-type={type}
      data-numeric
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'var(--text-lg)',
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: 'var(--tracking-snug)',
        color: 'var(--text-price)',
      }}
    >
      {label}
    </span>
  );
}
