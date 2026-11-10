import dsManifest from '@/ui/_ds_manifest.json';

/**
 * Spec 044 §3.6 — reads a design-system token's final value from `ui/_ds_manifest.json` (the source
 * `app/styles/apuriva-tokens.css` is generated from), following `var(--x)` aliases. The web app manifest's
 * colours come from here, never hand-written hex.
 */
interface DsToken {
  name: string;
  value: string;
}

export function resolveToken(name: string, tokens: readonly DsToken[] = (dsManifest as { tokens: DsToken[] }).tokens): string {
  const byName = new Map(tokens.map((t) => [t.name, t.value]));
  let value = byName.get(name);
  for (let depth = 0; value !== undefined && depth < 10; depth += 1) {
    const alias = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (!alias) return value;
    value = byName.get(alias[1]!);
  }
  throw new Error(`Design token ${name} does not resolve to a value in ui/_ds_manifest.json.`);
}
