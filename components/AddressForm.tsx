'use client';

import { useState } from 'react';
import { Alert } from '@/ui/components/feedback/Alert.jsx';
import { Button } from '@/ui/components/core/Button.jsx';
import { Checkbox } from '@/ui/components/forms/Checkbox.jsx';
import { FormField } from '@/ui/components/forms/FormField.jsx';
import { Input } from '@/ui/components/forms/Input.jsx';
import { Map } from './Map';
import type { StructuredAddress } from '@/lib/types/location';

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
export function AddressForm({ initialValue, submitLabel = 'Save address', pending = false, onGeocode, onSubmit, onCancel }: AddressFormProps) {
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
      setResolveError("We couldn't find that address — try a different search.");
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
      <FormField label="Search for an address" htmlFor="address-search" help="Type an address and find it — no location permission needed.">
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Input
            id="address-search"
            value={searchText}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchText(e.target.value)}
            placeholder="e.g. House 12, Street 5, Gulberg, Lahore"
          />
          <Button type="button" variant="secondary" loading={resolving} onClick={handleFindAddress}>
            Find
          </Button>
        </div>
      </FormField>

      {resolveError ? (
        <Alert tone="error" title="Something went wrong">
          {resolveError}
        </Alert>
      ) : null}

      {resolved ? (
        <>
          <Map approxAreaLabel={resolved.approxAreaLabel} latitude={resolved.latitude} longitude={resolved.longitude} height={140} />

          <FormField label="Label" htmlFor="address-label" required help="A name to help you recognize this address later, e.g. Home or Office.">
            <Input id="address-label" value={label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)} required />
          </FormField>

          <Checkbox
            label="Set as default address"
            checked={isDefault}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIsDefault(e.target.checked)}
          />
        </>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" loading={pending} disabled={!resolved || label.trim().length === 0}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
