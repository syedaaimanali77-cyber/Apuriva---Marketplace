import { describe, expect, it } from 'vitest';
import { approxAreaLabel, toAddressDto, toGeocodeResultDto } from './privacy';
import type { StructuredAddress } from '@/lib/types/location';

const point = { latitude: 31.5204, longitude: 74.3587 };
const structured: StructuredAddress = { line1: 'House 12, Street 5', area: 'Gulberg', city: 'Lahore', country: 'Pakistan' };

describe('lib/location/privacy (spec 012 AC-3/AC-4 exact-location stripping)', () => {
  it('approxAreaLabel joins area and city', () => {
    expect(approxAreaLabel(structured)).toBe('Gulberg, Lahore');
  });

  describe('toGeocodeResultDto', () => {
    it('AC-3: strips latitude, longitude, and structured.line1 for an unauthorized caller', () => {
      const dto = toGeocodeResultDto(point, structured, false);
      expect(dto.latitude).toBeUndefined();
      expect(dto.longitude).toBeUndefined();
      expect(dto.structured.line1).toBeUndefined();
      expect(dto.structured).toEqual({ area: 'Gulberg', city: 'Lahore', country: 'Pakistan' });
      expect(dto.approxAreaLabel).toBe('Gulberg, Lahore');
    });

    it('returns exact latitude, longitude, and line1 for an authorized caller', () => {
      const dto = toGeocodeResultDto(point, structured, true);
      expect(dto.latitude).toBe(point.latitude);
      expect(dto.longitude).toBe(point.longitude);
      expect(dto.structured.line1).toBe('House 12, Street 5');
    });
  });

  describe('toAddressDto (AC-4: assigned provider vs. everyone else)', () => {
    const saved = { id: 'addr-1', label: 'Home', isDefault: true };

    it('a customer browsing before selecting a provider never receives exact coordinates', () => {
      const dto = toAddressDto(saved, point, structured, false);
      expect(dto.latitude).toBeUndefined();
      expect(dto.longitude).toBeUndefined();
      expect(dto.structured.line1).toBeUndefined();
    });

    it('a provider other than the one assigned to the booking never receives exact coordinates', () => {
      // Same primitive call, same `authorized: false` — the caller (spec 020) decides this value
      // from its own booking-assignment check; the primitive itself can't tell "other provider"
      // from "pre-booking customer" apart, and per AC-4 it must treat both identically.
      const dto = toAddressDto(saved, point, structured, false);
      expect(dto.latitude).toBeUndefined();
      expect(dto.structured.line1).toBeUndefined();
    });

    it('the assigned provider on a confirmed booking receives the exact address', () => {
      const dto = toAddressDto(saved, point, structured, true);
      expect(dto.latitude).toBe(point.latitude);
      expect(dto.longitude).toBe(point.longitude);
      expect(dto.structured.line1).toBe('House 12, Street 5');
      expect(dto.id).toBe('addr-1');
      expect(dto.label).toBe('Home');
      expect(dto.isDefault).toBe(true);
    });
  });
});
