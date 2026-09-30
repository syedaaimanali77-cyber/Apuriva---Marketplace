/**
 * Spec 002 — derives `app/styles/apuriva-tokens.css` from `ui/_ds_manifest.json`, the design system's
 * source of truth in this repository. The CSS is never hand-edited: change a token in the manifest, run
 * this, and commit both. `components/tokens.test.ts` fails when the committed CSS is not this output.
 *
 * One section per manifest source file, in manifest order: the unscoped tokens in `:root`, then one block
 * per `scope` (`[data-theme="dark"]`, `[lang="ur"]`, the density scopes). The four root font-family tokens
 * are left out — `app/fonts.ts` supplies them through next/font.
 *
 * Usage: tsx scripts/generate-design-tokens.ts           writes the CSS
 *        tsx scripts/generate-design-tokens.ts --check   exits 1 if the committed CSS is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface DsManifestToken {
  name: string;
  value: string;
  definedIn: string;
  scope?: string;
}

const HEADER = `/**
 * APURIVA Design System tokens — generated verbatim from ui/_ds_manifest.json (the design
 * system's own source of truth) by scripts/generate-design-tokens.ts.
 *
 * Do not hand-edit token values here; regenerate from the manifest instead so this file never
 * drifts from ui/. --font-display / --font-sans / --font-mono / --font-urdu are intentionally
 * excluded — they're supplied by next/font/google in app/fonts.ts (self-hosted, no CDN link).
 */
`;

const SECTION_TITLES: Record<string, string> = {
  'tokens/colors.css': 'Colors',
  'tokens/typography.css': 'Typography',
  'tokens/spacing.css': 'Spacing',
  'tokens/radius.css': 'Radius',
  'tokens/elevation.css': 'Elevation',
  'tokens/motion.css': 'Motion',
  'tokens/layout.css': 'Layout',
  'tokens/semantic.css': 'Semantic aliases',
};

const NEXT_FONT_TOKENS = new Set(['--font-display', '--font-sans', '--font-mono', '--font-urdu']);

const ROOT = ':root';

export function renderTokensCss(tokens: readonly DsManifestToken[]): string {
  const sections = new Map<string, Map<string, DsManifestToken[]>>();
  for (const token of tokens) {
    const scope = token.scope ?? ROOT;
    if (scope === ROOT && NEXT_FONT_TOKENS.has(token.name)) continue;
    if (!(token.definedIn in SECTION_TITLES)) throw new Error(`generate-design-tokens: no section for ${token.definedIn} (${token.name}).`);
    const blocks = sections.get(token.definedIn) ?? new Map<string, DsManifestToken[]>([[ROOT, []]]);
    sections.set(token.definedIn, blocks);
    blocks.set(scope, [...(blocks.get(scope) ?? []), token]);
  }

  let css = HEADER;
  for (const [file, blocks] of sections) {
    css += `\n/* ---- ${SECTION_TITLES[file]} ---- */\n`;
    for (const [scope, scoped] of blocks) {
      css += `${scope} {\n${scoped.map((t) => `  ${t.name}: ${t.value};\n`).join('')}}\n`;
    }
  }
  return css;
}

export function run(argv: readonly string[], root = path.resolve(__dirname, '..')): number {
  const manifest = JSON.parse(readFileSync(path.join(root, 'ui/_ds_manifest.json'), 'utf8')) as { tokens: DsManifestToken[] };
  const target = path.join(root, 'app/styles/apuriva-tokens.css');
  const css = renderTokensCss(manifest.tokens);
  if (argv.includes('--check')) {
    const current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (current === css) return 0;
    console.error('app/styles/apuriva-tokens.css is stale — run: npx tsx scripts/generate-design-tokens.ts');
    return 1;
  }
  writeFileSync(target, css);
  console.log(`Wrote app/styles/apuriva-tokens.css (${manifest.tokens.length} manifest tokens).`);
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/generate-design-tokens.ts')) {
  process.exit(run(process.argv.slice(2)));
}
