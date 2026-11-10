import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import {
  isWithinAnyWindow,
  resolveWindowsForDate,
  validateOverrideShape,
  validateTimeZone,
  validateWeeklyEntries,
} from './resolve';
import type { WeeklyScheduleEntry } from '@/lib/types/availability';

/** Mon–Fri 9:00–18:00 — the example in spec 016 AC-1 and master spec §40. */
const MON_TO_FRI_9_TO_6: WeeklyScheduleEntry[] = [1, 2, 3, 4, 5].map((day) => ({
  dayOfWeek: day as 1 | 2 | 3 | 4 | 5,
  startMinute: 540,
  endMinute: 1080,
}));

function expectThrows(fn: () => void, code: string): ApiRouteError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRouteError);
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe('schedule resolution (spec 016 §3 R2–R6)', () => {
  describe('AC-1: override precedence (R3)', () => {
    it('an unavailable override replaces the weekly pattern for that date', () => {
      // Friday (day 5) is a working day in the weekly pattern...
      expect(resolveWindowsForDate(5, MON_TO_FRI_9_TO_6, undefined)).toEqual([{ startMinute: 540, endMinute: 1080 }]);

      // ...and the override removes it entirely, rather than narrowing or merging with it.
      const windows = resolveWindowsForDate(5, MON_TO_FRI_9_TO_6, {
        date: '2026-09-18',
        isAvailable: false,
        startMinute: null,
        endMinute: null,
      });
      expect(windows).toEqual([]);
    });

    it("an available override defines the day's only window, never merged with the weekly rows", () => {
      const windows = resolveWindowsForDate(3, MON_TO_FRI_9_TO_6, {
        date: '2026-09-16',
        isAvailable: true,
        startMinute: 600,
        endMinute: 720,
      });

      // Exactly the override's window — NOT the union with 9:00–18:00, and not its intersection.
      expect(windows).toEqual([{ startMinute: 600, endMinute: 720 }]);
    });

    it('an override for a day the weekly pattern does not cover still creates availability', () => {
      // Sunday has no weekly entry, yet the override alone makes the day available.
      const windows = resolveWindowsForDate(0, MON_TO_FRI_9_TO_6, {
        date: '2026-09-13',
        isAvailable: true,
        startMinute: 60,
        endMinute: 180,
      });
      expect(windows).toEqual([{ startMinute: 60, endMinute: 180 }]);
    });

    it('a day with no weekly entry and no override is unavailable', () => {
      expect(resolveWindowsForDate(6, MON_TO_FRI_9_TO_6, undefined)).toEqual([]);
    });
  });

  describe('R2: overlapping and touching entries', () => {
    it('accepts two separated windows on the same day', () => {
      expect(() =>
        validateWeeklyEntries([
          { dayOfWeek: 1, startMinute: 540, endMinute: 720 },
          { dayOfWeek: 1, startMinute: 780, endMinute: 1080 },
        ]),
      ).not.toThrow();
    });

    it('rejects overlapping entries on the same day', () => {
      const err = expectThrows(
        () =>
          validateWeeklyEntries([
            { dayOfWeek: 1, startMinute: 540, endMinute: 800 },
            { dayOfWeek: 1, startMinute: 780, endMinute: 1080 },
          ]),
        'INVALID_SCHEDULE_RANGE',
      );
      expect(err.status).toBe(422);
      expect(err.errors?.[0]?.field).toBe('entries[1].startMinute');
    });

    it('rejects TOUCHING entries — they must be submitted as one merged window', () => {
      expectThrows(
        () =>
          validateWeeklyEntries([
            { dayOfWeek: 2, startMinute: 540, endMinute: 720 },
            { dayOfWeek: 2, startMinute: 720, endMinute: 1080 },
          ]),
        'INVALID_SCHEDULE_RANGE',
      );
    });

    it('allows the same clock window on two different days', () => {
      expect(() => validateWeeklyEntries(MON_TO_FRI_9_TO_6)).not.toThrow();
    });

    it('accepts an empty set — "never available", which is still discoverable', () => {
      expect(() => validateWeeklyEntries([])).not.toThrow();
    });
  });

  describe('R5/R6: invalid ranges', () => {
    it('rejects a cross-midnight window expressed as start > end', () => {
      const err = expectThrows(
        () => validateWeeklyEntries([{ dayOfWeek: 1, startMinute: 1320, endMinute: 120 }]),
        'INVALID_SCHEDULE_RANGE',
      );
      expect(err.errors?.[0]?.message).toContain('two entries');
    });

    it('accepts 22:00–02:00 expressed as R5 requires: two same-day entries', () => {
      expect(() =>
        validateWeeklyEntries([
          { dayOfWeek: 1, startMinute: 1320, endMinute: 1440 },
          { dayOfWeek: 2, startMinute: 0, endMinute: 120 },
        ]),
      ).not.toThrow();
    });

    it('rejects end == start', () => {
      expectThrows(() => validateWeeklyEntries([{ dayOfWeek: 1, startMinute: 540, endMinute: 540 }]), 'INVALID_SCHEDULE_RANGE');
    });

    it('rejects a startMinute of 1440 — a zero-length window is meaningless', () => {
      expectThrows(() => validateWeeklyEntries([{ dayOfWeek: 1, startMinute: 1440, endMinute: 1440 }]), 'INVALID_SCHEDULE_RANGE');
    });

    it('accepts an endMinute of 1440 — "to midnight" is a real boundary', () => {
      expect(() => validateWeeklyEntries([{ dayOfWeek: 1, startMinute: 1380, endMinute: 1440 }])).not.toThrow();
    });

    it('rejects a non-integer minute', () => {
      expectThrows(() => validateWeeklyEntries([{ dayOfWeek: 1, startMinute: 540.5, endMinute: 1080 }]), 'INVALID_SCHEDULE_RANGE');
    });

    it('rejects an out-of-range dayOfWeek', () => {
      expectThrows(
        () => validateWeeklyEntries([{ dayOfWeek: 7 as unknown as 0, startMinute: 540, endMinute: 1080 }]),
        'INVALID_SCHEDULE_RANGE',
      );
    });

    it('reports EVERY offending entry, not just the first', () => {
      const err = expectThrows(
        () =>
          validateWeeklyEntries([
            { dayOfWeek: 1, startMinute: 900, endMinute: 600 },
            { dayOfWeek: 2, startMinute: 900, endMinute: 600 },
          ]),
        'INVALID_SCHEDULE_RANGE',
      );
      expect(err.errors).toHaveLength(2);
      expect(err.errors?.map((e) => e.field)).toEqual(['entries[0].endMinute', 'entries[1].endMinute']);
    });

    it('rejects an unknown IANA timezone', () => {
      expectThrows(() => validateTimeZone('Mars/Olympus_Mons'), 'INVALID_SCHEDULE_RANGE');
    });

    it('accepts a real IANA timezone', () => {
      expect(() => validateTimeZone('Asia/Karachi')).not.toThrow();
    });
  });

  describe('R3/R6: override shape', () => {
    it('rejects an unavailable override that carries minutes', () => {
      expectThrows(() => validateOverrideShape({ isAvailable: false, startMinute: 540, endMinute: 1080 }), 'INVALID_SCHEDULE_RANGE');
    });

    it('rejects an available override missing its minutes', () => {
      expectThrows(() => validateOverrideShape({ isAvailable: true }), 'INVALID_SCHEDULE_RANGE');
    });

    it('accepts a well-formed override of each kind', () => {
      expect(() => validateOverrideShape({ isAvailable: false })).not.toThrow();
      expect(() => validateOverrideShape({ isAvailable: true, startMinute: 600, endMinute: 720 })).not.toThrow();
    });
  });

  describe('R7: half-open window containment', () => {
    const windows = [{ startMinute: 540, endMinute: 1080 }];

    it('a candidate ending exactly when the window ends is inside it', () => {
      expect(isWithinAnyWindow(windows, 1020, 1080)).toBe(true);
    });

    it('a candidate starting exactly when the window starts is inside it', () => {
      expect(isWithinAnyWindow(windows, 540, 600)).toBe(true);
    });

    it('a candidate running one minute past the window is not', () => {
      expect(isWithinAnyWindow(windows, 1020, 1081)).toBe(false);
    });

    it('a candidate spanning a gap between two windows is not inside either', () => {
      const split = [
        { startMinute: 540, endMinute: 720 },
        { startMinute: 780, endMinute: 1080 },
      ];
      expect(isWithinAnyWindow(split, 700, 800)).toBe(false);
    });
  });
});
