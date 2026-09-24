import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 036 §6 "Boundary" — SOURCE-LEVEL guards, the idiom specs 020, 021, 030, 033 and 035 established:
 *   - tools call DOMAIN FUNCTIONS, never HTTP routes;
 *   - no tool bypasses spec 035's pipeline: nothing here calls a tool definition's `execute`;
 *   - nothing unredacted reaches `ai_tool_calls`: the recorder is only ever fed `redactInput`;
 *   - none of the deferred tools is implemented.
 */
const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'lib', 'mcp-tools');

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

const FILES = sourceFiles(DIR).filter(isProduction);
const rel = (file: string) => relative(ROOT, file);

describe('spec 036 module boundaries', () => {
  it('has production sources to check', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('never reaches a route: no app/ import and no HTTP call', () => {
    const offenders = FILES.filter((file) => /from\s+['"]@\/app\//.test(code(file)) || /\bfetch\s*\(/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('never executes a tool directly — every call goes through authorizeAndExecute', () => {
    const offenders = FILES.filter((file) => /definition\.execute\s*\(|tool\.execute\s*\(/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
    expect(code(join(DIR, 'executor.ts'))).toMatch(/authorizeAndExecute\(/);
  });

  it('writes ai_tool_calls only from the recorder, and the executor only ever feeds it redacted input', () => {
    const writers = FILES.filter((file) => /INSERT INTO ai_tool_calls|UPDATE ai_tool_calls/.test(code(file)));
    expect(writers.map(rel)).toEqual([rel(join(DIR, 'recorder.ts'))]);
    expect(code(join(DIR, 'executor.ts'))).toMatch(/const inputParams = tool \? redactInput\(input, tool\.fields\) : \{\}/);
  });

  it('implements none of the deferred tools', () => {
    const deferred = [
      'send_offer', 'accept_offer', 'request_offer_change', 'mark_provider_arrived', 'start_service', 'complete_service',
      'create_support_ticket', 'submit_review', 'send_provider_message', 'create_service_request', 'get_offers',
      'search_providers', 'get_provider', 'get_customer_profile',
    ];
    const offenders = FILES.flatMap((file) => deferred.filter((name) => new RegExp(`name:\\s*'${name}'`).test(code(file))).map((name) => `${rel(file)}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it('never marks offers viewed or notifications read — a read tool mutates nothing (AC-5)', () => {
    const offenders = FILES.filter((file) => /listOffersForCustomer|getOfferForCustomer|markViewed|markNotificationRead|markAllNotificationsRead/.test(code(file)));
    expect(offenders.map(rel)).toEqual([]);
  });
});
