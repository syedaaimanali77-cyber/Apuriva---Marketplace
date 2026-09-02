import { describe, expect, it } from 'vitest';

/**
 * Spec 002 AC-4: verifies the design token set against WCAG contrast requirements.
 * Values are read directly from app/styles/apuriva-tokens.css (generated verbatim from
 * ui/_ds_manifest.json) — never invented here. Two tiers apply per WCAG 2.1:
 *   - 4.5:1 for normal body/heading/label text (SC 1.4.3)
 *   - 3:1 for large text (>=18pt / >=14pt bold) and UI-component/graphical-object contrast
 *     (SC 1.4.11), which covers filled button/badge backgrounds against the page
 */

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

// Base palette — app/styles/apuriva-tokens.css, "Colors" section.
const teal600 = '#0A918C';
const navy900 = '#0A2338';
const navy800 = '#10334D';
const white = '#FFFFFF';
const gray50 = '#F8FAFB';
const gray500 = '#6B777B';
const gray600 = '#4F5B5F';
const gray700 = '#354044';
const error600 = '#C43D45';
const info600 = '#256D9B';
const infoBg = '#EAF4FB';
const neutralBg = '#F1F4F5';
const brandBg = '#EFFBFA';
const accentFg = '#A85D00';
const accentBg = '#FFF8EB';

// Semantic pairs resolved one level through app/styles/apuriva-tokens.css, "Semantic aliases".
const AA_TEXT_PAIRS: Array<[string, string, string]> = [
  ['--text-heading on --surface-page', navy900, gray50],
  ['--text-body on --surface-page', gray700, gray50],
  ['--text-heading on --surface-card', navy900, white],
  ['--text-body on --surface-card', gray700, white],
  ['--text-muted on --surface-card', gray600, white],
  ['--text-link on --surface-page', '#087F7A', gray50], // --text-link: var(--teal-700)
  ['--text-brand on --surface-page', '#087F7A', gray50], // --text-brand: var(--teal-700)
  ['--action-secondary-fg on --action-secondary-bg', '#087F7A', white],
  ['--action-ghost-fg on --surface-page', navy800, gray50],
  ['--action-danger-fg on --action-danger-bg', white, error600],
  ['--field-label on --surface-card', navy800, white],
  ['--field-help on --surface-card', gray500, white],
  ['--status-info-fg on --status-info-bg', info600, infoBg],
  ['--status-neutral-fg on --status-neutral-bg', gray600, neutralBg],
  ['--status-brand-fg on --status-brand-bg', '#087F7A', brandBg],
  ['--status-accent-fg on --status-accent-bg', accentFg, accentBg],
];

// Filled button/badge backgrounds — UI-component / large-semibold-text tier (3:1, SC 1.4.11).
const UI_COMPONENT_PAIRS: Array<[string, string, string]> = [
  ['--action-primary-fg on --action-primary-bg', white, teal600],
  ['--action-accent-fg on --action-accent-bg', white, '#C87500'], // amber-600
  ['--status-success-fg on --status-success-bg', '#168A5B', '#E8F7F0'],
  ['--status-warning-fg on --status-warning-bg', '#B86B00', '#FFF3DC'],
  ['--status-error-fg on --status-error-bg', error600, '#FDEBEC'],
];

describe('design token contrast (spec 002 AC-4)', () => {
  it.each(AA_TEXT_PAIRS)('%s meets 4.5:1 (WCAG AA normal text)', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(UI_COMPONENT_PAIRS)('%s meets 3:1 (WCAG AA large text / UI component)', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});
