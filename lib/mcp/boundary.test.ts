import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMcpTools } from './registry';

/**
 * Spec 035 §6 "Boundary" — SOURCE-LEVEL guards, the idiom specs 020, 021, 030 and 033 established,
 * so these invariants cannot rot as the spec grows.
 *
 * What is asserted here:
 *   - this spec registers NO business tool (the catalogue is spec 036's, §7);
 *   - nothing in `lib/mcp` reads or writes `ai_actions` — that table is wholly spec 034's (§4);
 *   - no parallel audit system: this spec creates no audit table and writes through its port;
 *   - no MCP SDK or transport dependency was introduced (§3 "Runtime and transport");
 *   - the pipeline is the only way to execute a tool.
 */
const ROOT = join(__dirname, '..', '..');
const MCP_DIR = join(ROOT, 'lib', 'mcp');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const isProduction = (file: string) => !/\.test\.tsx?$/.test(file) && !/test-support\.ts$/.test(file);

/** Comments describe the boundary, so matching raw text would fail a correct file for its prose. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MCP_FILES = sourceFiles(MCP_DIR).filter(isProduction);

describe('spec 035 module boundaries', () => {
  it('has production sources to check', () => {
    expect(MCP_FILES.length).toBeGreaterThan(5);
  });

  it('registers no business tool — the catalogue is spec 036s', () => {
    // Nothing has registered a tool at import time, and nothing in this module registers one.
    expect(listMcpTools()).toEqual([]);

    const offenders = MCP_FILES.filter((file) => /registerMcpTool\s*\(/.test(code(file)));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('never reads or writes ai_actions — that table is spec 034s', () => {
    const offenders = MCP_FILES.filter((file) => /ai_actions|aiActions|aiToolCalls|ai_tool_calls/.test(code(file)));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('creates no audit table and no parallel audit system — check 8 writes through the port', () => {
    const offenders = MCP_FILES.filter((file) => /audit_log|auditLogs|auditLog\b/.test(code(file)));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('introduces no MCP SDK or transport dependency', () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})];
    expect(names.filter((name) => /modelcontextprotocol|mcp-/i.test(name))).toEqual([]);

    const offenders = MCP_FILES.filter((file) => /from\s+['"]@modelcontextprotocol\//.test(code(file)));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('executes a tool only through the pipeline: execute() is called from authorize.ts alone', () => {
    const offenders = MCP_FILES.filter(
      (file) => /tool\.execute\s*\(/.test(code(file)) && !file.endsWith(join('lib', 'mcp', 'authorize.ts')),
    );
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('does not re-implement spec 034s risk mapping — it imports it', () => {
    const risk = MCP_FILES.filter((file) => /decideRisk|requiresConfirmation/.test(code(file)));
    expect(risk.length).toBeGreaterThan(0);
    for (const file of risk) {
      expect(code(file)).toMatch(/from\s+['"]@\/lib\/ai-assistant\/risk-policy['"]/);
    }
  });

  it('reads identity from the context only — no lib/mcp file reads a session cookie itself', () => {
    const offenders = MCP_FILES.filter((file) => /SESSION_COOKIE_NAME|validateAndRefreshSession/.test(code(file)));
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });
});
