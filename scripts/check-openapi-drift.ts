/**
 * CI/architecture check for spec 004 AC-7: "the OpenAPI document is generated ... it stays in
 * sync with the implementation (CI fails on drift)." Walks every route.ts file nested anywhere
 * under app/api/v1, extracts its exported HTTP method(s) and its URL path, and compares that set
 * against `lib/api/openapi-registry.ts` (the source `lib/api/openapi.ts` builds the served
 * document from) — failing if either side has an entry the other doesn't.
 *
 * Everything under app/api/v1/cron is excluded: scheduled-job trigger routes (spec 001 §8 risk
 * #1) are platform infrastructure invoked by Vercel Cron with its own bearer-secret auth, not
 * public REST API surface documented for API consumers, so they're deliberately outside this
 * spec's OpenAPI contract.
 *
 * Usage: npm run check:openapi-drift
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { OPENAPI_ROUTES, type OpenApiRouteEntry } from '../lib/api/openapi-registry';

const ROOT = join(__dirname, '..');
const API_V1_DIR = join(ROOT, 'app', 'api', 'v1');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function fail(message: string): never {
  console.error(`check:openapi-drift FAILED\n${message}`);
  process.exit(1);
}

function findRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findRouteFiles(full));
    } else if (entry === 'route.ts') {
      results.push(full);
    }
  }
  return results;
}

function toOpenApiPath(routeFile: string): string {
  const relDir = relative(API_V1_DIR, routeFile).split(sep).slice(0, -1); // drop "route.ts"
  const segments = relDir.map((segment) =>
    segment.startsWith('[') && segment.endsWith(']') ? `{${segment.slice(1, -1)}}` : segment,
  );
  return `/${segments.join('/')}`;
}

function extractMethods(source: string): string[] {
  const found = new Set<string>();
  for (const method of HTTP_METHODS) {
    const exportedFunction = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`);
    const exportedConst = new RegExp(`export\\s+const\\s+${method}\\s*=`);
    if (exportedFunction.test(source) || exportedConst.test(source)) found.add(method);
  }
  return [...found];
}

const routeFiles = findRouteFiles(API_V1_DIR).filter((f) => relative(API_V1_DIR, f).split(sep)[0] !== 'cron');

const implemented = new Set<string>();
for (const file of routeFiles) {
  const path = toOpenApiPath(file);
  const source = readFileSync(file, 'utf8');
  for (const method of extractMethods(source)) {
    implemented.add(`${method} ${path}`);
  }
}

const registered = new Set<string>(OPENAPI_ROUTES.map((r: OpenApiRouteEntry) => `${r.method} ${r.path}`));

const missingFromRegistry = [...implemented].filter((key) => !registered.has(key));
const missingFromFilesystem = [...registered].filter((key) => !implemented.has(key));

if (missingFromRegistry.length > 0 || missingFromFilesystem.length > 0) {
  const lines: string[] = [];
  if (missingFromRegistry.length > 0) {
    lines.push('Implemented under app/api/v1/** but missing from lib/api/openapi-registry.ts:');
    lines.push(...missingFromRegistry.map((k) => `  - ${k}`));
  }
  if (missingFromFilesystem.length > 0) {
    lines.push('Registered in lib/api/openapi-registry.ts but no matching app/api/v1/** route:');
    lines.push(...missingFromFilesystem.map((k) => `  - ${k}`));
  }
  fail(lines.join('\n'));
}

console.log(`check:openapi-drift PASSED — ${implemented.size} route(s) match the OpenAPI registry.`);
