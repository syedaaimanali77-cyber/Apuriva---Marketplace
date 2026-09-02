import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 002 AC-5: every components primitive's transition/animation is disabled or reduced
 * under prefers-reduced-motion. Verified two ways: the site-wide backstop rule in
 * app/globals.css, and the primitives that guard their own @keyframes inline (ui/'s existing
 * approach for Skeleton, kept as-is per this spec's note that ui/ is the source of truth).
 */
describe('prefers-reduced-motion (spec 002 AC-5)', () => {
  it('app/globals.css disables animation/transition duration under prefers-reduced-motion: reduce', () => {
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("Skeleton's own shimmer animation is guarded for prefers-reduced-motion", () => {
    const source = readFileSync(join(process.cwd(), 'ui/components/core/Skeleton.jsx'), 'utf8');
    expect(source).toMatch(/@media \(prefers-reduced-motion:reduce\)/);
    expect(source).toMatch(/animation:none!important/);
  });
});
