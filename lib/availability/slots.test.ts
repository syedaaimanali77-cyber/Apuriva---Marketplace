import { describe, expect, it } from 'vitest';
import { bufferedInterval, findConflictingInterval, generateSlots, intervalsOverlap, widestBufferMinutes, type BufferLookup } from './slots';
import type { BusyInterval } from './busy-intervals';
import type { WeeklyScheduleEntry } from '@/lib/types/availability';

const SERVICE = 'service-a';
const TZ = 'Asia/Karachi'; // UTC+5 year-round — no DST, so instants in these tests are exact.

function busy(startIso: string, endIso: string, serviceId = SERVICE): BusyInterval {
  return { startAt: new Date(startIso), endAt: new Date(endIso), serviceId, sourceId: 'busy-1' };
}

function buffers(before: number, after: number, serviceId = SERVICE): BufferLookup {
  return new Map([[serviceId, { bufferBeforeMinutes: before, bufferAfterMinutes: after }]]);
}

/** Wednesday 2026-09-16, 09:00–18:00 local = 04:00–13:00Z. */
const WEEKLY: WeeklyScheduleEntry[] = [{ dayOfWeek: 3, startMinute: 540, endMinute: 1080 }];

describe('buffers (spec 016 §3 R8)', () => {
  it('widens an occupied interval by its own service buffers on both sides', () => {
    const widened = bufferedInterval(busy('2026-09-16T10:00:00Z', '2026-09-16T11:00:00Z'), buffers(15, 30));
    expect(widened.startAt.toISOString()).toBe('2026-09-16T09:45:00.000Z');
    expect(widened.endAt.toISOString()).toBe('2026-09-16T11:30:00.000Z');
  });

  it('contributes no buffer for a service with no provider_services row', () => {
    const widened = bufferedInterval(busy('2026-09-16T10:00:00Z', '2026-09-16T11:00:00Z', 'unknown'), buffers(60, 60));
    expect(widened.startAt.toISOString()).toBe('2026-09-16T10:00:00.000Z');
    expect(widened.endAt.toISOString()).toBe('2026-09-16T11:00:00.000Z');
  });

  it('widestBufferMinutes reports the largest configured buffer across services', () => {
    const lookup: BufferLookup = new Map([
      ['a', { bufferBeforeMinutes: 10, bufferAfterMinutes: 20 }],
      ['b', { bufferBeforeMinutes: 45, bufferAfterMinutes: 5 }],
    ]);
    expect(widestBufferMinutes(lookup)).toBe(45);
  });
});

describe('half-open overlap (spec 016 §3 R7)', () => {
  it('touching intervals do not overlap', () => {
    expect(
      intervalsOverlap(
        { startAt: new Date('2026-09-16T10:00:00Z'), endAt: new Date('2026-09-16T11:00:00Z') },
        { startAt: new Date('2026-09-16T11:00:00Z'), endAt: new Date('2026-09-16T12:00:00Z') },
      ),
    ).toBe(false);
  });

  it('one-minute encroachment does overlap', () => {
    expect(
      intervalsOverlap(
        { startAt: new Date('2026-09-16T10:00:00Z'), endAt: new Date('2026-09-16T11:01:00Z') },
        { startAt: new Date('2026-09-16T11:00:00Z'), endAt: new Date('2026-09-16T12:00:00Z') },
      ),
    ).toBe(true);
  });
});

describe('AC-7: a slot adjacent to a busy interval within buffer_before/buffer_after is reported unavailable', () => {
  const occupied = [busy('2026-09-16T06:00:00Z', '2026-09-16T07:00:00Z')]; // 11:00–12:00 local

  it('with no buffers, the slot starting exactly when the interval ends IS available', () => {
    const conflict = findConflictingInterval(
      { startAt: new Date('2026-09-16T07:00:00Z'), endAt: new Date('2026-09-16T08:00:00Z') },
      occupied,
      buffers(0, 0),
    );
    expect(conflict).toBeUndefined();
  });

  it('with a 30-minute after-buffer, that same adjacent slot becomes unavailable', () => {
    const conflict = findConflictingInterval(
      { startAt: new Date('2026-09-16T07:00:00Z'), endAt: new Date('2026-09-16T08:00:00Z') },
      occupied,
      buffers(0, 30),
    );
    expect(conflict?.sourceId).toBe('busy-1');
  });

  it('with a 30-minute before-buffer, the slot ending exactly when the interval starts becomes unavailable', () => {
    const conflict = findConflictingInterval(
      { startAt: new Date('2026-09-16T05:00:00Z'), endAt: new Date('2026-09-16T06:00:00Z') },
      occupied,
      buffers(30, 0),
    );
    expect(conflict?.sourceId).toBe('busy-1');
  });

  it('generateSlots marks the buffered-adjacent grid position blockedBy "booking"', () => {
    const slots = generateSlots({
      from: '2026-09-16',
      to: '2026-09-16',
      timezone: TZ,
      weekly: WEEKLY,
      overrides: [],
      serviceId: SERVICE,
      durationMinutes: 60,
      busy: occupied,
      buffers: buffers(0, 30),
    });

    const adjacent = slots.find((slot) => slot.startAt === '2026-09-16T07:00:00.000Z');
    expect(adjacent).toMatchObject({ available: false, blockedBy: 'booking' });

    // 30 minutes later the buffer has elapsed, so the next grid position is free again.
    const afterBuffer = slots.find((slot) => slot.startAt === '2026-09-16T07:30:00.000Z');
    expect(afterBuffer).toMatchObject({ available: true, blockedBy: null });
  });
});

describe('slot generation (spec 016 §3 R7)', () => {
  const base = {
    from: '2026-09-16',
    to: '2026-09-16',
    timezone: TZ,
    weekly: WEEKLY,
    overrides: [],
    serviceId: SERVICE,
    durationMinutes: 60,
    busy: [] as BusyInterval[],
    buffers: buffers(0, 0),
  };

  it('lays the grid on 30-minute positions aligned to LOCAL midnight', () => {
    const slots = generateSlots(base);
    expect(slots).toHaveLength(48);
    // Local midnight in UTC+5 is 19:00Z the previous day.
    expect(slots[0]!.startAt).toBe('2026-09-15T19:00:00.000Z');
    expect(slots[1]!.startAt).toBe('2026-09-15T19:30:00.000Z');
  });

  it('offers only positions whose whole duration fits inside a window', () => {
    const slots = generateSlots(base);
    const available = slots.filter((slot) => slot.available);

    // 09:00–18:00 with a 60-minute service: 09:00 … 17:00 = 17 grid positions.
    expect(available).toHaveLength(17);
    expect(available[0]!.startAt).toBe('2026-09-16T04:00:00.000Z'); // 09:00 local
    expect(available.at(-1)!.startAt).toBe('2026-09-16T12:00:00.000Z'); // 17:00 local, ends 18:00
  });

  it('a longer duration reduces the offered positions accordingly', () => {
    const slots = generateSlots({ ...base, durationMinutes: 120 });
    const available = slots.filter((slot) => slot.available);
    expect(available).toHaveLength(15); // 09:00 … 16:00
    expect(available.at(-1)!.startAt).toBe('2026-09-16T11:00:00.000Z'); // 16:00 local, ends 18:00
  });

  it('marks positions outside the weekly pattern blockedBy "outside_schedule"', () => {
    const slots = generateSlots(base);
    const earlyMorning = slots.find((slot) => slot.startAt === '2026-09-15T22:00:00.000Z'); // 03:00 local
    expect(earlyMorning).toMatchObject({ available: false, blockedBy: 'outside_schedule' });
  });

  it('AC-1: an unavailable override blocks the whole day, blockedBy "override"', () => {
    const slots = generateSlots({
      ...base,
      overrides: [{ date: '2026-09-16', isAvailable: false, startMinute: null, endMinute: null }],
    });
    expect(slots.every((slot) => !slot.available)).toBe(true);
    expect(slots.every((slot) => slot.blockedBy === 'override')).toBe(true);
  });

  it("AC-1: an available override replaces the day's window rather than widening it", () => {
    const slots = generateSlots({
      ...base,
      overrides: [{ date: '2026-09-16', isAvailable: true, startMinute: 600, endMinute: 720 }],
    });
    const available = slots.filter((slot) => slot.available);
    // 10:00–12:00 with a 60-minute service: 10:00 and 10:30 and 11:00 = 3 positions.
    expect(available.map((slot) => slot.startAt)).toEqual([
      '2026-09-16T05:00:00.000Z',
      '2026-09-16T05:30:00.000Z',
      '2026-09-16T06:00:00.000Z',
    ]);
  });

  it('spans multiple local dates inclusively', () => {
    const slots = generateSlots({ ...base, from: '2026-09-16', to: '2026-09-18' });
    expect(slots).toHaveLength(48 * 3);
  });
});

describe('DST correctness (spec 016 §3 R1)', () => {
  it('keeps local 09:00 at local 09:00 across a spring-forward boundary', () => {
    // Europe/London moves to BST on 2026-03-29. Local 09:00 is 09:00Z before and 08:00Z after.
    const beforeDst = generateSlots({
      from: '2026-03-27',
      to: '2026-03-27',
      timezone: 'Europe/London',
      weekly: [{ dayOfWeek: 5, startMinute: 540, endMinute: 1080 }],
      overrides: [],
      serviceId: SERVICE,
      durationMinutes: 60,
      busy: [],
      buffers: buffers(0, 0),
    }).filter((slot) => slot.available)[0]!;

    const afterDst = generateSlots({
      from: '2026-03-30',
      to: '2026-03-30',
      timezone: 'Europe/London',
      weekly: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1080 }],
      overrides: [],
      serviceId: SERVICE,
      durationMinutes: 60,
      busy: [],
      buffers: buffers(0, 0),
    }).filter((slot) => slot.available)[0]!;

    expect(beforeDst.startAt).toBe('2026-03-27T09:00:00.000Z');
    expect(afterDst.startAt).toBe('2026-03-30T08:00:00.000Z');
  });
});
