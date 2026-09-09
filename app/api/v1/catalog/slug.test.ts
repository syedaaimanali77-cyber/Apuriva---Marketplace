import { describe, expect, it } from 'vitest';
import { normalizeSlug } from '@/lib/catalog/slug';

describe('normalizeSlug (spec 010 §3 Slug rules)', () => {
  it('lowercases and dash-separates a plain title', () => {
    expect(normalizeSlug('Home Repair & Maintenance')).toBe('home-repair-maintenance');
  });

  it('collapses consecutive non-alphanumeric characters into one dash', () => {
    expect(normalizeSlug('Beauty   &   Wellness')).toBe('beauty-wellness');
  });

  it('trims leading/trailing dashes', () => {
    expect(normalizeSlug('  Events  ')).toBe('events');
  });

  it('strips diacritics to plain ASCII', () => {
    expect(normalizeSlug('Café Services')).toBe('cafe-services');
  });

  it('is idempotent — normalizing an already-normalized slug is a no-op', () => {
    const once = normalizeSlug('Photography & Video');
    expect(normalizeSlug(once)).toBe(once);
  });
});
