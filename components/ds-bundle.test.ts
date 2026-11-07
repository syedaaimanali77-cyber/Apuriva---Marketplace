import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import dsManifest from '@/ui/_ds_manifest.json';
import { renderBundle } from '@/scripts/generate-ds-bundle';

/**
 * Spec 002 — `ui/_ds_bundle.js` (the design system's preview bundle) is generated from `ui/components/**` by
 * scripts/generate-ds-bundle.ts, so a primitive and its preview can never disagree.
 */

const root = path.resolve(__dirname, '..');
const bundle = readFileSync(path.join(root, 'ui/_ds_bundle.js'), 'utf8').replace(/\r\n/g, '\n');
const source = (sourcePath: string) => readFileSync(path.join(root, 'ui', sourcePath), 'utf8').replace(/\r\n/g, '\n');

function chunk(sourcePath: string): string {
  const start = bundle.indexOf(`// ${sourcePath}\n`);
  expect(start, `${sourcePath} is in the bundle`).toBeGreaterThanOrEqual(0);
  return bundle.slice(start, bundle.indexOf('}); }\n', start));
}

describe('design-system preview bundle (spec 002)', () => {
  it('ui/_ds_bundle.js is exactly what scripts/generate-ds-bundle.ts builds from ui/components', () => {
    expect(bundle).toBe(renderBundle(bundle, source));
  });

  it('carries the corrected primitives: the focus ring on the focused control, no opacity-0 inputs', () => {
    for (const sourcePath of ['components/forms/Input.jsx', 'components/forms/Select.jsx', 'components/forms/Checkbox.jsx', 'components/forms/Radio.jsx']) {
      const code = chunk(sourcePath);
      expect(code, sourcePath).toContain("boxShadow: focus ?");
      expect(code, sourcePath).not.toContain('opacity: 0,');
    }
  });

  it('draws the BottomTabBar unread badge with the semantic accent pair, not a raw palette colour', () => {
    const code = chunk('components/navigation/BottomTabBar.jsx');
    expect(code).toContain("background: 'var(--action-accent-bg)'");
    expect(code).toContain("color: 'var(--action-accent-fg)'");
    expect(code).not.toContain('--amber-600');
  });

  it('defines no token values of its own, and every var() it references is a manifest token', () => {
    const names = new Set((dsManifest as { tokens: Array<{ name: string }> }).tokens.map((t) => t.name));
    const referenced = new Set([...bundle.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!));
    expect([...referenced].filter((name) => !names.has(name))).toEqual([]);
    expect(bundle).not.toMatch(/--[\w-]+\s*:\s*#[0-9a-f]{3,8}/i);
  });
});
