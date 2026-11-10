import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOINDEX_WITHOUT_LAYOUT, noindexMetadata, ROUTE_POLICY } from './route-policy';

/**
 * Spec 044 §3.8 (AC-6, D-4) — deny by construction: every top-level `app/` segment with a `page.tsx` is
 * classified, and every `noindex` segment has the layout that says so. A new route cannot silently become
 * indexable.
 */
const APP = path.resolve(__dirname, '..', '..', 'app');

function hasPage(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (hasPage(full)) return true;
    } else if (entry === 'page.tsx') {
      return true;
    }
  }
  return false;
}

const segmentsWithPages = readdirSync(APP).filter((entry) => {
  const full = path.join(APP, entry);
  return statSync(full).isDirectory() && hasPage(full);
});

describe('route index policy (spec 044 §3.8)', () => {
  it('the root page is classified', () => {
    expect(existsSync(path.join(APP, 'page.tsx'))).toBe(true);
    expect(ROUTE_POLICY['']).toBe('index');
  });

  it('classifies every top-level app/ segment that has a page.tsx', () => {
    const unclassified = segmentsWithPages.filter((segment) => !(segment in ROUTE_POLICY));
    expect(unclassified).toEqual([]);
    expect(segmentsWithPages.length).toBeGreaterThan(5);
  });

  it('lists no segment that does not exist', () => {
    const stale = Object.keys(ROUTE_POLICY).filter((segment) => segment !== '' && !segmentsWithPages.includes(segment));
    expect(stale).toEqual([]);
  });

  it('indexes exactly /, /explore and its catalog pages; /search is noindex,follow; the rest noindex', () => {
    const indexed = Object.entries(ROUTE_POLICY).filter(([, c]) => c === 'index').map(([s]) => s);
    expect(indexed.sort()).toEqual(['', 'explore']);
    expect(ROUTE_POLICY.search).toBe('noindex-follow');
  });

  it('every noindex segment has a layout exporting noindexMetadata (or sets it on its own page)', () => {
    for (const [segment, cls] of Object.entries(ROUTE_POLICY)) {
      if (cls === 'index') continue;
      const file = NOINDEX_WITHOUT_LAYOUT.includes(segment) ? path.join(APP, segment, 'page.tsx') : path.join(APP, segment, 'layout.tsx');
      expect(existsSync(file), `${segment}: ${path.relative(APP, file)} exists`).toBe(true);
      const declared = /export const metadata(?:: Metadata)? = noindexMetadata\(([^)]*)\)/.exec(readFileSync(file, 'utf8'));
      expect(declared, `${segment} exports metadata = noindexMetadata(...)`).not.toBeNull();
      expect(declared![1]!.includes('follow: true'), `${segment} follow`).toBe(cls === 'noindex-follow');
    }
  });

  it('noindex metadata sets robots and clears the inherited canonical and Open Graph/Twitter URLs', () => {
    expect(noindexMetadata()).toMatchObject({ robots: { index: false, follow: false }, alternates: null, openGraph: null, twitter: null });
    expect(noindexMetadata({ follow: true }).robots).toEqual({ index: false, follow: true });
  });
});
