// Spec 046 §3.4 — ESLint flat config with Next's official rules (node_modules/next/dist/docs/01-app/
// 03-api-reference/05-config/03-eslint.md). Next 16 removed `next lint`; CI runs `npm run lint` (`eslint .`).
//
// Violations that existed when this gate was introduced are recorded in eslint-suppressions.json
// (ESLint bulk suppressions). New violations fail; a suppressed violation that gets fixed makes ESLint
// fail until the file is pruned with `npx eslint --prune-suppressions` — the list only ever shrinks.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // The generated Apuriva Design System bundle (spec 002): generated from ui/_ds_manifest.json, never hand-edited.
    'ui/**',
    // Build and test output.
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
  ]),
]);
