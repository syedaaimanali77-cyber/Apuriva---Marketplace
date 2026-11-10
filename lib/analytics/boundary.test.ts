import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 040 boundaries (AC-1, AC-3, AC-5, D-1, D-3): one ingestion path, emitters that never wait on
 * analytics, exactly the six X-list call sites, aggregate-only reports, no browser-facing ingestion
 * endpoint, and no queue or worker infrastructure.
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

const PRODUCTION = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))];
const rel = (file: string) => relative(ROOT, file).split(sep).join('/');
const code = (file: string) => readFileSync(file, 'utf8');
/** Source without comments, so a rule describing what is forbidden never trips its own check. */
const codeOnly = (file: string) =>
  code(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** §8 X-1…X-6 — each tracked action's single emitter. */
const EMITTERS: Record<string, string> = {
  'app/api/v1/search/route.ts': 'search_performed',
  'lib/requests/create.ts': 'request_submitted',
  'lib/offers/decide.ts': 'offer_accepted',
  'lib/bookings/complete.ts': 'booking_completed',
  'lib/reviews/create.ts': 'review_submitted',
  'lib/ai-assistant/conversations.ts': 'ai_conversation_started',
};

describe('spec 040 boundaries', () => {
  it('has production sources to check', () => {
    expect(PRODUCTION.length).toBeGreaterThan(100);
  });

  it('only lib/analytics/ingest.ts inserts into analytics_events', () => {
    const writers = PRODUCTION.filter((f) => /insert\(analyticsEvents\)|INSERT INTO\s+"?analytics_events/i.test(code(f))).map(rel);
    expect(writers).toEqual(['lib/analytics/ingest.ts']);
  });

  it('only lib/analytics/retention.ts deletes or updates analytics_events', () => {
    const writers = PRODUCTION.filter((f) =>
      /\.update\(analyticsEvents\)|\.delete\(analyticsEvents\)|UPDATE\s+"?analytics_events|DELETE\s+FROM\s+"?analytics_events/i.test(code(f)),
    ).map(rel);
    expect(writers).toEqual(['lib/analytics/retention.ts']);
  });

  it('recordAnalyticsEvent is called exactly from the six X-list emitters, each with its own event type', () => {
    const callers = PRODUCTION.filter((f) => /recordAnalyticsEvent\(/.test(code(f)) && !rel(f).startsWith('lib/analytics/')).map(rel);
    expect(callers.sort()).toEqual(Object.keys(EMITTERS).sort());
    for (const [file, type] of Object.entries(EMITTERS)) {
      const calls = code(join(ROOT, file)).match(/recordAnalyticsEvent\(\{\s*type:\s*'([a-z_]+)'/g) ?? [];
      expect(calls, file).toHaveLength(1);
      expect(calls[0], file).toContain(`'${type}'`);
    }
  });

  it('no emitter awaits, returns or chains analytics (AC-1, AC-5)', () => {
    for (const file of Object.keys(EMITTERS)) {
      expect(code(join(ROOT, file)), file).not.toMatch(/(await|return|void)\s+recordAnalyticsEvent\(|recordAnalyticsEvent\([^)]*\)\s*\.then/);
    }
    // And the function itself cannot be awaited meaningfully: it is declared to return void.
    expect(code(join(ROOT, 'lib/analytics/ingest.ts'))).toMatch(/export function recordAnalyticsEvent\(input: AnalyticsEventInput\): void/);
  });

  it('reports select no actor id, ranking score, contact data or fraud signal (AC-3, master §76)', () => {
    const reports = codeOnly(join(ROOT, 'lib/analytics/reports.ts'));
    expect(reports).not.toMatch(/actor_user_id|score_micros|score_breakdown|fraud|email|phone|display_name|full_name/);
    expect(reports).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    // The only `properties` reader is none: reports never look inside event payloads.
    expect(reports).not.toMatch(/properties/);
  });

  it('there is no ingestion HTTP endpoint and every analytics route is GET-only (D-3)', () => {
    expect(existsSync(join(ROOT, 'app/api/v1/analytics'))).toBe(false);
    const routes = PRODUCTION.filter((f) => rel(f).startsWith('app/api/v1/admin/analytics/') && f.endsWith('route.ts'));
    expect(routes).toHaveLength(7);
    for (const route of routes) expect(code(route), rel(route)).not.toMatch(/export const (POST|PUT|PATCH|DELETE)\b/);
  });

  it('introduces no queue, worker or packages infrastructure (§3.2, spec 001 §8)', () => {
    expect(existsSync(join(ROOT, 'apps'))).toBe(false);
    expect(existsSync(join(ROOT, 'packages'))).toBe(false);
    for (const file of sources(join(ROOT, 'lib/analytics'))) {
      expect(code(file), rel(file)).not.toMatch(/bullmq|pg-boss|amqplib|kafkajs|@aws-sdk\/client-sqs/);
    }
  });

  it('AI usage is reused, not re-derived: no analytics module aggregates ai_usage_events', () => {
    for (const file of sources(join(ROOT, 'lib/analytics'))) expect(code(file), rel(file)).not.toMatch(/ai_usage_events|aiUsageEvents/);
    expect(code(join(ROOT, 'app/admin/analytics/page.tsx'))).toContain("'/api/v1/admin/ai/usage'");
  });
});
