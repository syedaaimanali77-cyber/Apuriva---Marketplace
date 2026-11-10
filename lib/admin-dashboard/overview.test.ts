import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Executor } from '@/lib/offers/db';

const mocks = vi.hoisted(() => ({ holdsPermission: vi.fn(), requireAnyAdminRole: vi.fn() }));
vi.mock('./access', () => ({ holdsPermission: mocks.holdsPermission, requireAnyAdminRole: mocks.requireAnyAdminRole }));

import {
  ACTIVE_BOOKING_STATUSES,
  alertsFor,
  criticalSafetyReportsMessage,
  getAdminOverview,
  utcDayBounds,
} from './overview';

/** A fake executor answering every aggregate with `n` (and revenue with no rows). */
function executorReturning(n: number): Executor & { calls: number } {
  const exec = {
    calls: 0,
    async execute() {
      exec.calls += 1;
      return { rows: [{ n }] } as never;
    },
  };
  return exec as unknown as Executor & { calls: number };
}

describe('spec 037 Overview rules (unit)', () => {
  beforeEach(() => {
    mocks.holdsPermission.mockReset();
    mocks.requireAnyAdminRole.mockReset().mockResolvedValue(['support_admin']);
  });

  it('active bookings are exactly the five in-flight statuses (D-8)', () => {
    expect(ACTIVE_BOOKING_STATUSES).toEqual(['pending', 'confirmed', 'provider_en_route', 'arrived', 'in_progress']);
  });

  it('the UTC day is [00:00:00Z, next 00:00:00Z) whatever the local time of `now`', () => {
    expect(utcDayBounds(new Date('2026-09-25T23:59:59.999Z'))).toEqual({
      start: new Date('2026-09-25T00:00:00.000Z'),
      end: new Date('2026-09-26T00:00:00.000Z'),
    });
    expect(utcDayBounds(new Date('2026-09-25T00:00:00.000Z')).start.toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('exact singular and plural alert messages', () => {
    expect(criticalSafetyReportsMessage(1)).toBe('1 critical safety report needs attention.');
    expect(criticalSafetyReportsMessage(3)).toBe('3 critical safety reports need attention.');
  });

  it('no open critical report → no alert', async () => {
    mocks.holdsPermission.mockResolvedValue(true);
    expect(await alertsFor(executorReturning(0), 'u1')).toEqual([]);
  });

  it('one → exactly one alert, count 1, singular message, the safety queue link', async () => {
    mocks.holdsPermission.mockResolvedValue(true);
    expect(await alertsFor(executorReturning(1), 'u1')).toEqual([
      {
        rule: 'critical_safety_reports',
        severity: 'critical',
        count: 1,
        message: '1 critical safety report needs attention.',
        linkTo: '/admin/operations/safety',
      },
    ]);
  });

  it('three → still ONE aggregated alert, count 3, plural message', async () => {
    mocks.holdsPermission.mockResolvedValue(true);
    const alerts = await alertsFor(executorReturning(3), 'u1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ count: 3, message: '3 critical safety reports need attention.' });
  });

  it('without safety_reports/read the alert is omitted and the query is never run', async () => {
    mocks.holdsPermission.mockResolvedValue(false);
    const db = executorReturning(5);
    expect(await alertsFor(db, 'u1')).toEqual([]);
    expect(db.calls).toBe(0);
    expect(mocks.holdsPermission).toHaveBeenCalledWith('u1', 'safety_reports', 'read');
  });

  it('getAdminOverview refuses a non-admin before running any query', async () => {
    mocks.requireAnyAdminRole.mockRejectedValue(new Error('FORBIDDEN'));
    const db = executorReturning(1);
    await expect(getAdminOverview('u1', { db })).rejects.toThrow('FORBIDDEN');
    expect(db.calls).toBe(0);
  });
});
