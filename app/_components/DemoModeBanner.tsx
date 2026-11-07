'use client';

import { Alert, Badge } from '@/components';
import { useLocale } from './LocaleProvider';

/**
 * Spec 045 §5 / AC-3 — master §111's "clear Demo Mode label". Rendered from app/layout.tsx (X-3) only when the
 * server-side condition holds (`demo-mode` on, `APP_ENV` not `production`), so it shows on every page for
 * guests and signed-in users alike. The design system's `Alert` (`tone="info"`, `role="status"`) and `Badge`;
 * deliberately no dismiss control, so it stays visible for the whole session.
 */
export function DemoModeBanner() {
  const { t } = useLocale();
  return (
    <div style={{ padding: 'var(--space-2) var(--space-4)' }} data-testid="demo-mode-banner">
      <Alert tone="info">
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Badge tone="brand" icon={null} size="sm">
            {t('demo.banner.label')}
          </Badge>
          {t('demo.banner.text')}
        </span>
      </Alert>
    </div>
  );
}
