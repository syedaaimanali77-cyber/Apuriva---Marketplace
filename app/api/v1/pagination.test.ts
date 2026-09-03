import { describe, expect, it } from 'vitest';
import { buildPage, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, parsePageParams } from '@/lib/api/pagination';

describe('pagination (spec 004 AC-6)', () => {
  it('defaults limit/offset when absent', () => {
    expect(parsePageParams(new URLSearchParams())).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  it('parses valid caller-supplied limit/offset', () => {
    expect(parsePageParams(new URLSearchParams('limit=10&offset=20'))).toEqual({ limit: 10, offset: 20 });
  });

  it('caps limit at MAX_PAGE_LIMIT', () => {
    expect(parsePageParams(new URLSearchParams(`limit=${MAX_PAGE_LIMIT + 500}`)).limit).toBe(MAX_PAGE_LIMIT);
  });

  it('falls back to defaults for non-numeric or non-positive values', () => {
    expect(parsePageParams(new URLSearchParams('limit=abc&offset=-5'))).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  it('computes nextOffset when more rows remain', () => {
    expect(buildPage(50, 20, 0)).toEqual({ limit: 20, offset: 0, total: 50, nextOffset: 20 });
    expect(buildPage(50, 20, 20)).toEqual({ limit: 20, offset: 20, total: 50, nextOffset: 40 });
  });

  it('nextOffset is null once the last page is reached', () => {
    expect(buildPage(50, 20, 40)).toEqual({ limit: 20, offset: 40, total: 50, nextOffset: null });
    expect(buildPage(0, 20, 0)).toEqual({ limit: 20, offset: 0, total: 0, nextOffset: null });
  });
});
