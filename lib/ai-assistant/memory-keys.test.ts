/**
 * Spec 034 §3.9 / AC-19 — the CLOSED three-key allow-list and each key's value shape (no database:
 * the published-category rule is covered by `memory.integration.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { AI_MEMORY_KEYS, isAiMemoryKey, validateMemoryShape } from './memory-keys';
import { AI_MEMORY_KEY_LABELS } from './labels';

const CATEGORY_ID = '4f9d2c1e-8b7a-4c3d-9e2f-1a2b3c4d5e6f';

describe('memory allow-list (§3.9, AC-19)', () => {
  it('is exactly preferred_category, preferred_area and language', () => {
    expect([...AI_MEMORY_KEYS]).toEqual(['preferred_category', 'preferred_area', 'language']);
    expect(Object.keys(AI_MEMORY_KEY_LABELS).sort()).toEqual([...AI_MEMORY_KEYS].sort());
  });

  it('rejects every key outside the allow-list, including provider-characteristic and communication-preference keys', () => {
    for (const key of [
      'preferred_provider_characteristics',
      'provider_characteristics',
      'communication_preferences',
      'communication_preference',
      'notes',
      'full_conversation',
      'PREFERRED_AREA',
      '',
      null,
      42,
    ]) {
      expect(isAiMemoryKey(key)).toBe(false);
      const result = validateMemoryShape(key, { anything: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]!.field).toBe('key');
    }
  });

  it('never reinterprets an unsupported key as a supported one', () => {
    const result = validateMemoryShape('communication_preferences', { language: 'en' });
    expect(result.ok).toBe(false);
  });
});

describe('value shapes (§3.9)', () => {
  it('preferred_category takes exactly { categoryId }', () => {
    expect(validateMemoryShape('preferred_category', { categoryId: CATEGORY_ID })).toEqual({
      ok: true,
      entry: { key: 'preferred_category', value: { categoryId: CATEGORY_ID } },
    });
    expect(validateMemoryShape('preferred_category', { categoryId: 'plumbing' }).ok).toBe(false);
    expect(validateMemoryShape('preferred_category', { categoryId: CATEGORY_ID, note: 'x' }).ok).toBe(false);
  });

  it('preferred_area takes only the coarse city/area — a street, address id or coordinates are rejected', () => {
    expect(validateMemoryShape('preferred_area', { city: ' Lahore ', area: ' DHA ' })).toEqual({
      ok: true,
      entry: { key: 'preferred_area', value: { city: 'Lahore', area: 'DHA' } },
    });
    expect(validateMemoryShape('preferred_area', { city: 'Lahore' }).ok).toBe(true);
    for (const extra of [{ street: '12 Main Blvd' }, { addressId: CATEGORY_ID }, { lat: 31.5, lng: 74.3 }, { line1: 'House 4' }]) {
      expect(validateMemoryShape('preferred_area', { city: 'Lahore', ...extra }).ok).toBe(false);
    }
    expect(validateMemoryShape('preferred_area', { city: '   ' }).ok).toBe(false);
    expect(validateMemoryShape('preferred_area', { area: 'DHA' }).ok).toBe(false);
    expect(validateMemoryShape('preferred_area', { city: 'Lahore', area: '' }).ok).toBe(false);
  });

  it('language is one of master spec §5.1’s three: en, ur, ur-Latn', () => {
    for (const language of ['en', 'ur', 'ur-Latn']) {
      expect(validateMemoryShape('language', { language }).ok).toBe(true);
    }
    for (const language of ['fr', 'EN', 'roman_urdu', 'ur-latn', '']) {
      expect(validateMemoryShape('language', { language }).ok).toBe(false);
    }
    expect(validateMemoryShape('language', { language: 'en', tone: 'brief' }).ok).toBe(false);
  });

  it('rejects a non-object value', () => {
    for (const value of [null, 'Lahore', ['Lahore'], 3]) {
      expect(validateMemoryShape('preferred_area', value).ok).toBe(false);
    }
  });
});
