import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 039 boundaries (AC-3, D-9): one write path, no second audit system, nothing that can edit
 * or delete an entry, and spec 005's `security_events` left to security events.
 */
const ROOT = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|test-support\.ts$|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const PRODUCTION = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app')), join(ROOT, 'instrumentation.ts')];
const rel = (file: string) => relative(ROOT, file).split(sep).join('/');
const code = (file: string) => readFileSync(file, 'utf8');

describe('spec 039 boundaries', () => {
  it('has production sources to check', () => {
    expect(PRODUCTION.length).toBeGreaterThan(100);
  });

  it('only lib/audit/write.ts inserts into audit_logs', () => {
    const writers = PRODUCTION.filter((f) => /insert\(auditLogs\)|INSERT INTO\s+"?audit_logs/i.test(code(f))).map(rel);
    expect(writers).toEqual(['lib/audit/write.ts']);
  });

  it('only the spec 009 hook and the MCP sink call writeAuditEntry (D-9: no second public audit API)', () => {
    const callers = PRODUCTION.filter((f) => /(await|return)\s+writeAuditEntry\(/.test(code(f))).map(rel).sort();
    expect(callers).toEqual(['lib/admin-rbac/audit.ts', 'lib/audit/mcp-sink.ts']);
  });

  it('no production code updates, deletes or truncates audit_logs (AC-2)', () => {
    const offenders = PRODUCTION.filter((f) =>
      /\.update\(auditLogs\)|\.delete\(auditLogs\)|UPDATE\s+"?audit_logs"?\s+SET|DELETE\s+FROM\s+"?audit_logs|TRUNCATE\s+(TABLE\s+)?"?audit_logs/.test(code(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the admin audit hook no longer writes to security_events (AC-3, D-1)', () => {
    const hook = code(join(ROOT, 'lib', 'admin-rbac', 'audit.ts'));
    expect(hook).not.toMatch(/recordSecurityEvent\(|from '@\/lib\/auth\/security-event'|insert\(securityEvents\)/);
    expect(hook).toMatch(/writeAuditEntry\(/);
  });

  it('lib/audit never writes to security_events', () => {
    const offenders = sources(join(ROOT, 'lib', 'audit')).filter((f) => /securityEvents|INTO\s+"?security_events|recordSecurityEvent\(/.test(code(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('lib/mcp is not modified to name the audit table (spec 035 boundary); the sink lives in lib/audit', () => {
    const offenders = sources(join(ROOT, 'lib', 'mcp')).filter((f) => /from '@\/lib\/audit\/|auditLogs|INTO\s+"?audit_logs/.test(code(f)));
    expect(offenders.map(rel)).toEqual([]);
    expect(code(join(ROOT, 'lib', 'audit', 'mcp-sink.ts'))).toMatch(/McpAuditSink/);
  });

  it('instrumentation.ts registers the durable integration (X-4)', () => {
    expect(code(join(ROOT, 'instrumentation.ts'))).toMatch(/import\('@\/lib\/audit\/register'\)[\s\S]*registerAuditIntegration\(\)/);
  });

  it('withApiRoute runs every handler inside the request context (X-1)', () => {
    expect(code(join(ROOT, 'lib', 'api', 'handler.ts'))).toMatch(/runWithRequestContext\(\{ correlationId \}/);
  });

  it('there is no ai actor type (D-7)', () => {
    expect(code(join(ROOT, 'lib', 'types', 'audit.ts'))).toMatch(/AUDIT_ACTOR_TYPES = \['admin', 'user', 'system'\] as const/);
  });

  it('the audit-log routes expose no write method', () => {
    for (const file of sources(join(ROOT, 'app', 'api', 'v1', 'admin', 'audit-logs'))) {
      expect(code(file)).not.toMatch(/export const (POST|PUT|PATCH|DELETE)\b/);
    }
  });
});
