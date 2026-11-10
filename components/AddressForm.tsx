'use client';

import { useState } from 'react';
import { Alert } from '@/ui/components/feedback/Alert.jsx';
import { Button } from '@/ui/components/core/Button.jsx';
import { Checkbox } from '@/ui/components/forms/Checkbox.jsx';
import { FormField } from '@/ui/components/forms/FormField.jsx';
import { Input } from '@/ui/components/forms/Input.jsx';
import { Map } from './Map';
import type { StructuredAddress } from '@/lib/types/location';
import { useLocale } from '@/app/_components/LocaleProvider';

export interface ResolvedPoint {
  latitude: number;
  longitude: number;
  structured: StructuredAddress;
  approxAreaLabel: string;
}

export interface AddressFormValue {
  label: string;
  structured: StructuredAddress;
  latitude: number;
  longitude: number;
  isDefault: boolean;
}

export interface AddressFormProps {
  initialValue?: Partial<AddressFormValue>;
  submitLabel?: string;
  pending?: boolean;
  /** Spec 012 §3 `POST /api/v1/location/geocode` — resolves free-text address to a point.
   * `null` return means the vendor couldn't resolve it (§3 `GEOCODING_FAILED`). */
  onGeocode: (addressText: string) => Promise<ResolvedPoint | null>;
  onSubmit: (value: AddressFormValue) => void;
  onCancel?: () => void;
}

/**
 * Spec 012 §5 — add/edit a saved address. There is no pin-drop map (§8 risk #1: no real maps
 * vendor selected yet, only `lib/location`'s sandbox adapter) — "manual entry" here means typing
 * the address text and letting the sandbox geocoder resolve it, which never requires device GPS
 * permission, satisfying AC-2's "general discovery is not blocked" without ever prompting for
 * location. §5 UI states: Loading (resolving), Error (couldn't resolve, retry the text), Success
 * (resolved address shown on `Map`, with an editable label before saving).
 */
export function AddressForm({ initialValue, submitLabel, pending = false, onGeocode, onSubmit, onCancel }: AddressFormProps) {
  // Spec 042 X-12: labels translated. The address the user types is free text and is sent exactly as
  // entered — the structure stays country-neutral (AC-4).
  const { t } = useLocale();
  const [searchText, setSearchText] = useState(initialValue?.structured?.line1 ?? '');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedPoint | null>(
    initialValue?.latitude !== undefined && initialValue?.longitude !== undefined && initialValue.structured
      ? {
          latitude: initialValue.latitude,
          longitude: initialValue.longitude,
          structured: initialValue.structured,
          approxAreaLabel: [initialValue.structured.area, initialValue.structured.city].filter(Boolean).join(', '),
        }
      : null,
  );
  const [label, setLabel] = useState(initialValue?.label ?? '');
  const [isDefault, setIsDefault] = useState(initialValue?.isDefault ?? false);

  async function handleFindAddress() {
    if (searchText.trim().length === 0) return;
    setResolveError(null);
    setResolving(true);
    const result = await onGeocode(searchText.trim());
    setResolving(false);
    if (!result) {
      setResolveError(t('comp.address.notFound'));
      return;
    }
    setResolved(result);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!resolved || label.trim().length === 0) return;
    onSubmit({ label: label.trim(), structured: resolved.structured, latitude: resolved.latitude, longitude: resolved.longitude, isDefault });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <FormField label={t('comp.address.searchLabel')} htmlFor="address-search" help={t('comp.address.searchHelp')}>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Input
            id="address-search"
            value={searchText}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchText(e.target.value)}
            placeholder={t('comp.address.placeholder')}
          />
          <Button type="button" variant="secondary" loading={resolving} onClick={handleFindAddress}>
            {t('comp.address.find')}
          </Button>
        </div>
      </FormField>

      {resolveError ? (
        <Alert tone="error" title={t('common.somethingWentWrong')}>
          {resolveError}
        </Alert>
      ) : null}

      {resolved ? (
        <>
          <Map approxAreaLabel={resolved.approxAreaLabel} latitude={resolved.latitude} longitude={resolved.longitude} height={140} />

          <FormField label={t('comp.address.label')} htmlFor="address-label" required help={t('comp.address.labelHelp')}>
            <Input id="address-label" value={label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)} required />
          </FormField>

          <Checkbox
            label={t('comp.address.default')}
            checked={isDefault}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIsDefault(e.target.checked)}
          />
        </>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button type="submit" variant="primary" loading={pending} disabled={!resolved || label.trim().length === 0}>
          {submitLabel ?? t('comp.address.save')}
        </Button>
      </div>
    </form>
  );
}
