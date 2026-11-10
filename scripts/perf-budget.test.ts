import { describe, expect, it } from 'vitest';
import { lhciArgs, resolveBudgetUrls } from './perf-budget';

describe('perf-budget (spec 044 §3.7)', () => {
  const base = 'http://localhost:3100';

  it('resolves the six budget routes from the first category that has a published service', async () => {
    const responses: Record<string, unknown> = {
      [`${base}/api/v1/categories`]: { data: [{ id: 'empty-cat' }, { id: 'cat-1' }] },
      [`${base}/api/v1/categories/empty-cat/page`]: { data: { popularServices: [] } },
      [`${base}/api/v1/categories/cat-1/page`]: { data: { popularServices: [{ id: 'svc-1' }, { id: 'svc-2' }] } },
    };
    expect(await resolveBudgetUrls(base, async (u) => responses[u])).toEqual([
      `${base}/`,
      `${base}/explore`,
      `${base}/explore/cat-1`,
      `${base}/explore/cat-1/svc-1`,
      `${base}/search?q=cleaning`,
      `${base}/login`,
    ]);
  });

  it('refuses to measure without a published service rather than silently shrinking the route set', async () => {
    await expect(resolveBudgetUrls(base, async (u) => (u.endsWith('/categories') ? { data: [{ id: 'c' }] } : { data: { popularServices: [] } }))).rejects.toThrow(
      /no published category/,
    );
  });

  it('passes the repository config and one --collect.url per route to lhci autorun', () => {
    expect(lhciArgs('/repo/lighthouserc.json', ['a', 'b'])).toEqual(['autorun', '--config=/repo/lighthouserc.json', '--collect.url=a', '--collect.url=b']);
  });
});
