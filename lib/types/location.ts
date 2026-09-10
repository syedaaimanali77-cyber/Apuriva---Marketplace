/** Spec 012 §3 Request and response types. */

export interface StructuredAddress {
  /** Street-level detail — stripped alongside latitude/longitude for an unauthorized caller. */
  line1?: string;
  area: string;
  city: string;
  country: string;
}

/** A freshly geocoded/reverse-geocoded point — never a saved address (no `id`/`label` yet). */
export interface GeocodeResultDto {
  structured: StructuredAddress;
  latitude?: number;
  longitude?: number;
  approxAreaLabel: string;
}

export interface AddressDto {
  id: string;
  label: string;
  isDefault: boolean;
  structured: StructuredAddress;
  latitude?: number;
  longitude?: number;
  approxAreaLabel: string;
}

export interface GeocodeRequest {
  address: string;
}

export interface ReverseGeocodeRequest {
  latitude: number;
  longitude: number;
}

export interface CreateAddressRequest {
  label: string;
  structured: StructuredAddress;
  latitude: number;
  longitude: number;
  isDefault?: boolean;
}

export interface UpdateAddressRequest {
  label?: string;
  structured?: StructuredAddress;
  latitude?: number;
  longitude?: number;
  isDefault?: boolean;
}
