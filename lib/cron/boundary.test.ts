import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRON_SCHEDULES } from './schedules';

/**
 * Spec 046 §3.2 / X-3 — every Vercel Cron route runs inside `withCronRoute` under its own job name,
 * and no route keeps its own bearer check (the one constant-time check lives in the wrapper).
 */
const CRON_DIR = path.resolve(__dirname, '../../app/api/v1/cron');
const routeDirs = readdirSync(CRON_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('cron route boundary (spec 046 X-3)', () => {
  it('has exactly one route per vercel.json job, and one job per route', () => {
    expect(routeDirs).toEqual(CRON_SCHEDULES.map((s) => s.job).sort());
  });

  it.each(routeDirs)('%s is wrapped by withCronRoute under its own name, with no inline secret check', (dir) => {
    const src = readFileSync(path.join(CRON_DIR, dir, 'route.ts'), 'utf8');
    expect(src).toContain(`export const GET = withCronRoute('${dir}', `);
    expect(src).not.toMatch(/process\.env\.CRON_SECRET/);
    expect(src).not.toMatch(/export async function GET/);
  });
});
