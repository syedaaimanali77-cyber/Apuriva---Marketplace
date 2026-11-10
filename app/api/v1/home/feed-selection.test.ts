import { describe, expect, it } from 'vitest';
import { selectFeedMode } from '@/lib/home/feed';

/** Spec 014 §6 unit level — the new-vs-returning/active-booking section-selection decision,
 * pure and DB-independent (§8 risk 1). */
describe('selectFeedMode (spec 014)', () => {
  it('AC-1: no recent-relevant items yields curated_popular', () => {
    expect(selectFeedMode({ personalizationEnabled: true, hasRecentRelevantItems: false })).toBe('curated_popular');
  });

  it('AC-2: a returning user with recent-relevant items yields recent_relevant', () => {
    expect(selectFeedMode({ personalizationEnabled: true, hasRecentRelevantItems: true })).toBe('recent_relevant');
  });

  it('AC-7: personalization disabled always falls back to curated_popular, even with history', () => {
    expect(selectFeedMode({ personalizationEnabled: false, hasRecentRelevantItems: true })).toBe('curated_popular');
  });

  it('AC-7: personalization disabled with no history is still curated_popular', () => {
    expect(selectFeedMode({ personalizationEnabled: false, hasRecentRelevantItems: false })).toBe('curated_popular');
  });
});
