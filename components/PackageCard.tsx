'use client';

import { Card } from './Card';
import { useLocale } from '@/app/_components/LocaleProvider';
import { formatMoney } from '@/lib/i18n/format';
import type { ServicePackageDto } from '@/lib/types/service-page';

/**
 * Spec 011 §5 — a single `ServicePackage` on a service page. Built from existing tokens (same
 * app-facing-primitive pattern as `components/ConfirmDialog.tsx`, not a `ui/` design-system
 * component). Spec 042 X-11: the price through the shared locale-aware `formatMoney`; the package's
 * name, description and items are provider content and render as authored (§7).
 */
export function PackageCard({ servicePackage }: { servicePackage: ServicePackageDto }) {
  const { locale } = useLocale();
  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{servicePackage.name}</h3>
        {servicePackage.description ? <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{servicePackage.description}</p> : null}
        <span
          data-numeric
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-lg)',
            fontWeight: 'var(--weight-semibold)',
            letterSpacing: 'var(--tracking-snug)',
            color: 'var(--text-price)',
          }}
        >
          {formatMoney(servicePackage.amountMinorUnits, servicePackage.currencyCode, locale)}
        </span>
        {servicePackage.includedItems.length > 0 ? (
          <ul style={{ margin: 0, paddingInlineStart: 'var(--space-5)', color: 'var(--text-body)', fontSize: 'var(--text-sm)' }}>
            {servicePackage.includedItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
