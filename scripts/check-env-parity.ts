/**
 * CI/local check for spec 001 AC-3: every `process.env.X` read anywhere in the application's
 * own source must have a matching documented entry in `.env.example`.
 *
 * Usage: npm run check:env
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const SCAN_ROOTS = ['app', 'lib', 'scripts', 'drizzle.config.ts'];
const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIR_NAMES = new Set(['node_modules', '.next', 'drizzle']);
const ENV_VAR_PATTERN = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const SELF_PATH = relative(ROOT, __filename).replace(/\\/g, '/');

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (!IGNORED_DIR_NAMES.has(entry)) collectFiles(fullPath, files);
      continue;
    }
    const ext = entry.slice(entry.lastIndexOf('.'));
    if (SCANNABLE_EXTENSIONS.has(ext)) files.push(fullPath);
  }
  return files;
}

function findSourceFiles(): string[] {
  const files: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const fullPath = join(ROOT, scanRoot);
    try {
      const stats = statSync(fullPath);
      if (stats.isDirectory()) collectFiles(fullPath, files);
      else files.push(fullPath);
    } catch {
      // scan root doesn't exist yet — nothing to scan there
    }
  }
  return files.filter((f) => relative(ROOT, f).replace(/\\/g, '/') !== SELF_PATH);
}

function findEnvVarsInCode(): Map<string, string[]> {
  const varsToFiles = new Map<string, string[]>();
  for (const file of findSourceFiles()) {
    const content = readFileSync(file, 'utf8');
    const relPath = relative(ROOT, file).replace(/\\/g, '/');
    for (const match of content.matchAll(ENV_VAR_PATTERN)) {
      const name = match[1];
      const existing = varsToFiles.get(name) ?? [];
      if (!existing.includes(relPath)) existing.push(relPath);
      varsToFiles.set(name, existing);
    }
  }
  return varsToFiles;
}

function findDocumentedVars(): Set<string> {
  const envExamplePath = join(ROOT, '.env.example');
  const content = readFileSync(envExamplePath, 'utf8');
  const documented = new Set<string>();
  for (const line of content.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) documented.add(match[1]);
  }
  return documented;
}

function main() {
  const usedVars = findEnvVarsInCode();
  const documentedVars = findDocumentedVars();

  const undocumented = [...usedVars.keys()].filter((name) => !documentedVars.has(name));

  if (undocumented.length > 0) {
    console.error('Undocumented environment variables found (missing from .env.example):\n');
    for (const name of undocumented) {
      console.error(`  ${name}  (read in: ${usedVars.get(name)!.join(', ')})`);
    }
    console.error('\nAdd each one to .env.example with a placeholder value, then re-run.');
    process.exit(1);
  }

  console.log(
    `OK — ${usedVars.size} environment variable(s) read in code, all documented in .env.example.`,
  );
}

main();
