import type { PricingModel } from '@/lib/types/catalog';
import type { PriceDisplay, PriceDisplayType } from '@/lib/types/service-page';

const DISPLAY_TYPE_BY_MODEL: Record<PricingModel, PriceDisplayType> = {
  fixed: 'exact',
  package: 'starting',
  custom: 'range',
  quote: 'quote',
  hourly: 'hourly',
};

interface PackageAmount {
  amountMinorUnits: number;
  currencyCode: string;
}

/**
 * Spec 011 §2 AC-2: maps a service's `pricingModel` to its display (fixed → exact price,
 * package → starting price, custom → range, quote → "get offers", hourly → hourly rate).
 * `ServicePackage` (spec 011 §4) is the only entity carrying an actual amount anywhere in this
 * scope, so the displayed amount — when one applies — is the cheapest of the service's packages;
 * `quote` never carries an amount, and a service with no packages yet shows the bare type with no
 * amount rather than a fabricated number.
 */
export function computePriceDisplay(pricingModel: PricingModel, packages: PackageAmount[]): PriceDisplay {
  const type = DISPLAY_TYPE_BY_MODEL[pricingModel];
  if (type === 'quote' || packages.length === 0) return { type };

  const cheapest = packages.reduce((min, p) => (p.amountMinorUnits < min.amountMinorUnits ? p : min), packages[0]!);
  return { type, amountMinorUnits: cheapest.amountMinorUnits, currencyCode: cheapest.currencyCode };
}
