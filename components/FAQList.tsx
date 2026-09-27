'use client';

import { Icon } from './Icon';
import { useLocale } from '@/app/_components/LocaleProvider';

export interface FaqListItem {
  id: string;
  question: string;
  answer: string;
  source: 'official' | 'provider';
}

/**
 * Spec 011 §5/AC-6 — FAQ source is shown via icon+label, never color alone (master spec §3.5).
 * Built from existing tokens (same app-facing-primitive pattern as `components/ConfirmDialog.tsx`,
 * not a `ui/` design-system component).
 */
export function FAQList({ faqs, emptyMessage }: { faqs: FaqListItem[]; emptyMessage?: string }) {
  // Spec 042: the platform labels are translated; each FAQ's question and answer is catalog content (§7).
  const { t } = useLocale();
  if (faqs.length === 0) {
    return <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>{emptyMessage ?? t('comp.faq.empty')}</p>;
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-4)' }}>
      {faqs.map((faq) => (
        <li key={faq.id} style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{faq.question}</h3>
          </div>
          <p style={{ margin: 0, color: 'var(--text-body)', fontSize: 'var(--text-base)' }}>{faq.answer}</p>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            <Icon name={faq.source === 'official' ? 'badge-check' : 'user'} size="xs" />
            {faq.source === 'official' ? t('comp.faq.official') : t('comp.faq.provider')}
          </span>
        </li>
      ))}
    </ul>
  );
}
