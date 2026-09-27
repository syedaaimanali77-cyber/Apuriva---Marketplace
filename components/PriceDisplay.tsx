'use client';

import type { PriceDisplay as PriceDisplayValue } from '@/lib/types/service-page';

function formatMoney(amountMinorUnits: number, currencyCode: string): string {
  try {
    // A pinned locale (not `undefined`, which resolves to whatever locale the runtime
    // environment defaults to — e.g. "US$50.00" vs "$50.00" for the same USD amount) keeps this
    // deterministic across server/client rendering and test environments.
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(amountMinorUnits / 100);
  } catch {
    return `${(amountMinorUnits / 100).toFixed(2)} ${currencyCode}`;
  }
}

/**
 * Spec 011 §5/AC-2 — pricing-model-aware price display, built from existing tokens (same
 * app-facing-primitive pattern as `components/ConfirmDialog.tsx`, not a `ui/` design-system
 * component). Maps `priceDisplay.type` to its label: `exact` → the price, `starting` → "From",
 * `range` → "From ... (custom pricing)", `quote` → "Get offers", `hourly` → "/hr".
 */
export function PriceDisplay({ priceDisplay }: { priceDisplay: PriceDisplayValue }) {
  const { type, amountMinorUnits, currencyCode } = priceDisplay;
  const amount = amountMinorUnits !== undefined && currencyCode !== undefined ? formatMoney(amountMinorUnits, currencyCode) : null;

  let label: string;
  switch (type) {
    case 'exact':
      label = amount ?? 'Price to be confirmed';
      break;
    case 'starting':
      label = amount ? `From ${amount}` : 'Starting price to be confirmed';
      break;
    case 'range':
      label = amount ? `From ${amount} (custom pricing)` : 'Custom pricing';
      break;
    case 'hourly':
      label = amount ? `${amount}/hr` : 'Hourly rate to be confirmed';
      break;
    case 'quote':
    default:
      label = 'Get offers';
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
