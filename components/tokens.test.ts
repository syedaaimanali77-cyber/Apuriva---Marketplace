import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import dsManifest from '@/ui/_ds_manifest.json';
import { renderTokensCss, type DsManifestToken } from '@/scripts/generate-design-tokens';

/**
 * Spec 002 AC-4: verifies the design token set against WCAG contrast requirements.
 * Values are read from ui/_ds_manifest.json (the source app/styles/apuriva-tokens.css is generated
 * from) — never written here. Every pair below is rendered as normal-size text somewhere in the app
 * (button labels are 13–16px semibold, badge labels 11–12px), so all of them are held to the 4.5:1
 * tier of WCAG 2.1 SC 1.4.3; none qualifies for the 3:1 large-text tier.
 */

const tokens = (dsManifest as { tokens: DsManifestToken[] }).tokens;
const rootTokens = new Map(tokens.filter((t) => !t.scope).map((t) => [t.name, t.value]));

/** A token's final hex value, following `var(--x)` aliases. */
function resolve(name: string): string {
  let value = rootTokens.get(name);
  for (let depth = 0; value !== undefined && depth < 10; depth += 1) {
    const alias = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (!alias) return value;
    value = rootTokens.get(alias[1]!);
  }
  throw new Error(`Design token ${name} does not resolve to a value in ui/_ds_manifest.json.`);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(clean.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

// Foreground token on background token.
const AA_TEXT_PAIRS: Array<[string, string]> = [
  ['--text-heading', '--surface-page'],
  ['--text-body', '--surface-page'],
  ['--text-heading', '--surface-card'],
  ['--text-body', '--surface-card'],
  ['--action-secondary-fg', '--action-secondary-bg'],
  ['--action-ghost-fg', '--surface-page'],
  ['--action-danger-fg', '--action-danger-bg'],
  ['--action-danger-fg', '--action-danger-bg-hover'],
  ['--field-label', '--surface-card'],
  ['--field-help', '--surface-card'],
  ['--field-help', '--surface-page'],
  ['--status-info-fg', '--status-info-bg'],
  ['--status-neutral-fg', '--status-neutral-bg'],
  ['--status-brand-fg', '--status-brand-bg'],
  ['--status-accent-fg', '--status-accent-bg'],
  // Filled buttons and status badges: their labels are normal-size text (spec 043 §1's five pairs), in
  // every state a label is read in.
  ['--action-primary-fg', '--action-primary-bg'],
  ['--action-primary-fg', '--action-primary-bg-hover'],
  ['--action-primary-fg', '--action-primary-bg-active'],
  ['--action-accent-fg', '--action-accent-bg'],
  ['--action-accent-fg', '--action-accent-bg-hover'],
  ['--status-success-fg', '--status-success-bg'],
  ['--status-warning-fg', '--status-warning-bg'],
  ['--status-error-fg', '--status-error-bg'],
];

// Secondary text and links sit on any light surface the design system defines (page, card, sunken, the
// brand/accent tints and the status tints), so each must pass on all of them.
const LIGHT_SURFACES = [
  '--surface-page',
  '--surface-card',
  '--surface-sunken',
  '--surface-brand-subtle',
  '--surface-accent-subtle',
  '--status-success-bg',
  '--status-warning-bg',
  '--status-error-bg',
  '--status-info-bg',
];
const TEXT_ON_ANY_LIGHT_SURFACE = ['--text-muted', '--text-subtle', '--text-link', '--text-brand'];

const ALL_PAIRS: Array<[string, string]> = [
  ...AA_TEXT_PAIRS,
  ...TEXT_ON_ANY_LIGHT_SURFACE.flatMap((fg) => LIGHT_SURFACES.map((bg): [string, string] => [fg, bg])),
];

describe('design token contrast (spec 002 AC-4)', () => {
  it.each(ALL_PAIRS)('%s on %s meets 4.5:1 (WCAG AA normal text)', (fg, bg) => {
    expect(contrastRatio(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps each filled button state distinguishable from the one before it', () => {
    expect(new Set(['--action-primary-bg', '--action-primary-bg-hover', '--action-primary-bg-active'].map(resolve)).size).toBe(3);
    expect(resolve('--action-accent-bg-hover')).not.toBe(resolve('--action-accent-bg'));
  });
});

describe('design token CSS (spec 002)', () => {
  it('app/styles/apuriva-tokens.css is exactly what scripts/generate-design-tokens.ts derives from the manifest', () => {
    const committed = readFileSync(path.resolve(__dirname, '../app/styles/apuriva-tokens.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderTokensCss(tokens));
  });
});
