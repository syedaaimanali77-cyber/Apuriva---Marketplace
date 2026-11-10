/**
 * Spec 046 §3.2 / AC-5 — the ONE source of cron job names and schedules: `vercel.json`, which is
 * what Vercel Cron actually runs. A job's name is its route's last path segment
 * (`/api/v1/cron/payment-sweep` → `payment-sweep`), and `withCronRoute(job, …)` must use one of
 * these names (enforced by `lib/cron/boundary.test.ts`).
 *
 * Staleness (AC-5): a job is stale when its last success is older than max(3 × its schedule
 * interval, 10 minutes). The interval is the LONGEST gap between two consecutive firings in a day,
 * so a job firing at uneven times is judged by its worst case, never its best.
 */
import vercelConfig from '@/vercel.json';

const MINUTES_PER_DAY = 24 * 60;
const MIN_STALE_MS = 10 * 60 * 1000;

export interface CronSchedule {
  job: string;
  path: string;
  schedule: string;
  intervalMinutes: number;
  staleAfterMs: number;
}

/** Values a single cron field allows, from `*`, `*∕n`, `a`, `a-b` and comma lists. */
function expandField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const step = /^\*\/(\d+)$/.exec(part);
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (part === '*') {
      for (let v = min; v <= max; v += 1) values.add(v);
    } else if (step) {
      const n = Number(step[1]);
      if (n < 1) throw new Error(`Invalid cron step "${part}"`);
      for (let v = min; v <= max; v += n) values.add(v);
    } else if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b || a < min || b > max) throw new Error(`Invalid cron range "${part}"`);
      for (let v = a; v <= b; v += 1) values.add(v);
    } else if (/^\d+$/.test(part)) {
      const v = Number(part);
      if (v < min || v > max) throw new Error(`Cron value "${part}" is out of range ${min}-${max}`);
      values.add(v);
    } else {
      throw new Error(`Unsupported cron field "${part}"`);
    }
  }
  return [...values].sort((x, y) => x - y);
}

/**
 * The longest gap, in minutes, between consecutive firings over a (wrapping) day. Only the minute
 * and hour fields may be restricted: day-of-month, month and day-of-week must be `*`, which is true
 * of every schedule in `vercel.json` — anything else throws rather than guess an interval.
 */
export function cronIntervalMinutes(schedule: string): number {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron schedule "${schedule}" must have 5 fields`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') {
    throw new Error(`Cron schedule "${schedule}" restricts a day or month field, which is not supported`);
  }
  const firings: number[] = [];
  for (const h of expandField(hour, 0, 23)) {
    for (const m of expandField(minute, 0, 59)) firings.push(h * 60 + m);
  }
  firings.sort((x, y) => x - y);
  let longest = firings[0]! + MINUTES_PER_DAY - firings[firings.length - 1]!;
  for (let i = 1; i < firings.length; i += 1) longest = Math.max(longest, firings[i]! - firings[i - 1]!);
  return longest;
}

export function staleAfterMs(intervalMinutes: number): number {
  return Math.max(3 * intervalMinutes * 60 * 1000, MIN_STALE_MS);
}

export function jobNameFromPath(path: string): string {
  const name = path.split('/').filter(Boolean).pop();
  if (!name) throw new Error(`Cron path "${path}" has no job segment`);
  return name;
}

export function parseCronSchedules(crons: ReadonlyArray<{ path: string; schedule: string }>): CronSchedule[] {
  return crons.map(({ path, schedule }) => {
    const intervalMinutes = cronIntervalMinutes(schedule);
    return { job: jobNameFromPath(path), path, schedule, intervalMinutes, staleAfterMs: staleAfterMs(intervalMinutes) };
  });
}

export const CRON_SCHEDULES: readonly CronSchedule[] = parseCronSchedules(vercelConfig.crons);

export function cronSchedule(job: string): CronSchedule | undefined {
  return CRON_SCHEDULES.find((s) => s.job === job);
}
