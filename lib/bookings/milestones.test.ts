import { describe, expect, it } from 'vitest';
import { BOOKING_MILESTONE_TYPES } from '@/lib/db/schema';
import { isMilestoneType, MAX_MILESTONE_NOTE_LENGTH, parseMilestoneRequest } from './milestones';

/** Spec 028 §6 "Unit" — the milestone vocabulary and note rules, with no database. */
describe('milestone request parsing (spec 028 §3)', () => {
  it('accepts each shipped milestone type', () => {
    for (const milestoneType of BOOKING_MILESTONE_TYPES) {
      const body = milestoneType === 'custom' ? { milestoneType, note: 'Tiles laid' } : { milestoneType };
      expect(parseMilestoneRequest(body)).toEqual({ milestoneType, note: milestoneType === 'custom' ? 'Tiles laid' : null });
    }
  });

  /**
   * The vocabulary is CLOSED. The draft spec typed it as `... | string`, which collapses to `string`
   * and would have let any value through to the database.
   */
  it('rejects a milestone type outside the closed vocabulary', () => {
    for (const milestoneType of ['arrived', 'completed', 'STARTED', '', 42, null]) {
      expect(() => parseMilestoneRequest({ milestoneType })).toThrowError();
    }
    expect(isMilestoneType('nearly_there')).toBe(false);
  });

  it('requires a note for a custom milestone, and only for a custom milestone', () => {
    expect(() => parseMilestoneRequest({ milestoneType: 'custom' })).toThrowError();
    expect(() => parseMilestoneRequest({ milestoneType: 'custom', note: '   ' })).toThrowError();
    expect(parseMilestoneRequest({ milestoneType: 'working' })).toEqual({ milestoneType: 'working', note: null });
  });

  it('trims a note, treats blank as absent, and bounds its length', () => {
    expect(parseMilestoneRequest({ milestoneType: 'working', note: '  halfway  ' })).toEqual({
      milestoneType: 'working',
      note: 'halfway',
    });
    expect(parseMilestoneRequest({ milestoneType: 'working', note: '' })).toEqual({
      milestoneType: 'working',
      note: null,
    });
    expect(() =>
      parseMilestoneRequest({ milestoneType: 'working', note: 'x'.repeat(MAX_MILESTONE_NOTE_LENGTH + 1) }),
    ).toThrowError();
    expect(
      parseMilestoneRequest({ milestoneType: 'working', note: 'x'.repeat(MAX_MILESTONE_NOTE_LENGTH) }).note,
    ).toHaveLength(MAX_MILESTONE_NOTE_LENGTH);
  });

  it('rejects a non-string note rather than coercing it', () => {
    expect(() => parseMilestoneRequest({ milestoneType: 'working', note: 12 })).toThrowError();
    expect(() => parseMilestoneRequest({ milestoneType: 'working', note: { text: 'hi' } })).toThrowError();
  });

  it('rejects an empty body', () => {
    expect(() => parseMilestoneRequest({})).toThrowError();
    expect(() => parseMilestoneRequest(null)).toThrowError();
  });

  /**
   * AC-9 — there is no location field anywhere in the milestone contract. A body carrying one is
   * parsed to exactly the same value as one without, so a coordinate cannot even be persisted,
   * let alone act on the state machine.
   */
  it('ignores any location-shaped field a caller invents (AC-9)', () => {
    const withLocation = parseMilestoneRequest({
      milestoneType: 'working',
      note: 'halfway',
      latitude: 31.52,
      longitude: 74.35,
      accuracyMeters: 5,
      geofence: 'arrived',
    });
    expect(withLocation).toEqual({ milestoneType: 'working', note: 'halfway' });
    expect(Object.keys(withLocation)).toEqual(['milestoneType', 'note']);
  });
});
