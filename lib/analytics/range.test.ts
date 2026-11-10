import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS, parseReportRange, previousRange, ratio, round } from './range';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const DAY = 86_400_000;

function parse(query: string) {
  return parseReportRange(new URLSearchParams(query), NOW);
}

function validationFields(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; errors?: { field: string }[] };
    expect(e.code).toBe('VALIDATION_ERROR');
    return (e.errors ?? []).map((x) => x.field);
  }
  throw new Error('expected a VALIDATION_ERROR');
}

describe('report range W = [from, to) (spec 040 §3.5)', () => {
  it('defaults to the last 30 days ending now', () => {
    const range = parse('');
    expect(range.to.toISOString()).toBe(NOW.toISOString());
    expect(range.to.getTime() - range.from.getTime()).toBe(DEFAULT_RANGE_DAYS * DAY);
  });

  it('defaults `from` relative to an explicit `to`', () => {
    const range = parse('to=2026-01-31');
    expect(range.to.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(range.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts ISO dates and instants', () => {
    const range = parse('from=2026-01-01&to=2026-02-01T06:30:00Z');
    expect(range.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-02-01T06:30:00.000Z');
  });

  it('rejects malformed values, from >= to, and spans over 366 days', () => {
    expect(validationFields(() => parse('from=yesterday'))).toEqual(['from']);
    expect(validationFields(() => parse('to=2026-13-45'))).toContain('to');
    expect(validationFields(() => parse('from=2026-02-01&to=2026-02-01'))).toEqual(['from']);
    expect(validationFields(() => parse('from=2026-03-01&to=2026-02-01'))).toEqual(['from']);
    const tooLong = new Date(Date.parse('2026-01-01') + (MAX_RANGE_DAYS + 1) * DAY).toISOString();
    expect(validationFields(() => parse(`from=2026-01-01&to=${tooLong}`))).toEqual(['from']);
    // Exactly 366 days is allowed.
    const edge = new Date(Date.parse('2026-01-01') + MAX_RANGE_DAYS * DAY).toISOString();
    expect(() => parse(`from=2026-01-01&to=${edge}`)).not.toThrow();
  });

  it('previousRange is the equal-length window immediately before W', () => {
    const prev = previousRange({ from: new Date('2026-02-01T00:00:00Z'), to: new Date('2026-02-11T00:00:00Z') });
    expect(prev.from.toISOString()).toBe('2026-01-22T00:00:00.000Z');
    expect(prev.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('ratio and round follow the §3.6 rounding rules', () => {
    expect(ratio(1, 3, 4)).toBe(0.3333);
    expect(ratio(2, 3, 2)).toBe(0.67);
    expect(ratio(5, 0, 4)).toBeNull();
    expect(ratio(0, 7, 4)).toBe(0);
    expect(ratio(7, 2, 4)).toBe(3.5);
    expect(round(12.345, 1)).toBe(12.3);
  });
});
