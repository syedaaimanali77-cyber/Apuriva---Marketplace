import { describe, expect, it } from 'vitest';
import vercelConfig from '@/vercel.json';
import { CRON_SCHEDULES, cronIntervalMinutes, cronSchedule, jobNameFromPath, parseCronSchedules, staleAfterMs } from './schedules';

describe('cron schedules (spec 046 §3.2, AC-5)', () => {
  it.each([
    ['* * * * *', 1],
    ['*/5 * * * *', 5],
    ['0 * * * *', 60],
    ['0 3 * * *', 1440],
    ['30 3 * * *', 1440],
    ['0,30 * * * *', 30],
    ['0 9-17 * * *', 960], // 17:00 → next day 09:00 is the longest gap
    ['15,45 */6 * * *', 330],
  ])('%s fires at most every %i minutes', (schedule, minutes) => {
    expect(cronIntervalMinutes(schedule)).toBe(minutes);
  });

  it('refuses schedules it cannot interpret instead of guessing', () => {
    expect(() => cronIntervalMinutes('* * *')).toThrow(/5 fields/);
    expect(() => cronIntervalMinutes('0 0 1 * *')).toThrow(/not supported/);
    expect(() => cronIntervalMinutes('0 0 * * 1')).toThrow(/not supported/);
    expect(() => cronIntervalMinutes('61 * * * *')).toThrow(/out of range/);
    expect(() => cronIntervalMinutes('*/0 * * * *')).toThrow(/step/);
    expect(() => cronIntervalMinutes('5-2 * * * *')).toThrow(/range/);
    expect(() => cronIntervalMinutes('x * * * *')).toThrow(/Unsupported/);
  });

  it('stale = max(3 × interval, 10 minutes)', () => {
    expect(staleAfterMs(1)).toBe(10 * 60_000);
    expect(staleAfterMs(5)).toBe(15 * 60_000);
    expect(staleAfterMs(60)).toBe(180 * 60_000);
    expect(staleAfterMs(1440)).toBe(3 * 1440 * 60_000);
  });

  it('names a job by its last path segment', () => {
    expect(jobNameFromPath('/api/v1/cron/payment-sweep')).toBe('payment-sweep');
    expect(() => jobNameFromPath('/')).toThrow();
  });

  it('parses every schedule in vercel.json, one per cron route, with unique job names', () => {
    expect(CRON_SCHEDULES).toHaveLength(vercelConfig.crons.length);
    expect(new Set(CRON_SCHEDULES.map((s) => s.job)).size).toBe(CRON_SCHEDULES.length);
    expect(cronSchedule('offer-expiry-sweep')).toMatchObject({ intervalMinutes: 1, staleAfterMs: 10 * 60_000 });
    expect(cronSchedule('no-such-job')).toBeUndefined();
    expect(parseCronSchedules([{ path: '/api/v1/cron/x', schedule: '*/5 * * * *' }])[0]).toEqual({
      job: 'x',
      path: '/api/v1/cron/x',
      schedule: '*/5 * * * *',
      intervalMinutes: 5,
      staleAfterMs: 15 * 60_000,
    });
  });
});
