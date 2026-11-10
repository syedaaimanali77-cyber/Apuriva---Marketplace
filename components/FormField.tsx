'use client';

import { FormField as DsFormField, type FormFieldProps } from '@/ui/components/forms/FormField';
import { useLocale } from '@/app/_components/LocaleProvider';

export { useFieldIds } from '@/ui/components/forms/FormField';
export type { FormFieldProps };

/**
 * Spec 042 X-2 (§5.2) — the DS `FormField`, whose "Optional" marker is fixed English with no prop. Under
 * `en` it renders unchanged; otherwise the marker is rendered here, translated, in the DS's own style.
 */
export function FormField({ optional, label, ...props }: FormFieldProps) {
  const { locale, t } = useLocale();
  if (locale === 'en' || !optional || !label) return <DsFormField optional={optional} label={label} {...props} />;
  return (
    <DsFormField
      {...props}
      label={
        <>
          {label}
          <span style={{ fontWeight: 'var(--weight-regular)', color: 'var(--text-subtle)' }}>{t('common.optional')}</span>
        </>
      }
    />
  );
}
