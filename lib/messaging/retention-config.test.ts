import { afterEach, describe, expect, it } from 'vitest';
import { getMessageRetentionDays } from './retention-config';

/** Spec 025 §4 "Retention and privacy" — the configurable window, its default and its floor. */
describe('getMessageRetentionDays (spec 025 §4)', () => {
  const original = process.env.MESSAGE_RETENTION_DAYS;

  afterEach(() => {
    if (original === undefined) delete process.env.MESSAGE_RETENTION_DAYS;
    else process.env.MESSAGE_RETENTION_DAYS = original;
  });

  it('defaults to 730 days when unset', () => {
    delete process.env.MESSAGE_RETENTION_DAYS;
    expect(getMessageRetentionDays()).toBe(730);
  });

  it.each(['abc', '', '-5', '0', '12.5'])('falls back to 730 for an invalid value (%j)', (value) => {
    process.env.MESSAGE_RETENTION_DAYS = value;
    expect(getMessageRetentionDays()).toBe(730);
  });

  it('honours a configured value at or above the floor', () => {
    process.env.MESSAGE_RETENTION_DAYS = '365';
    expect(getMessageRetentionDays()).toBe(365);
  });

  it('clamps a configured value below 90 up to 90', () => {
    process.env.MESSAGE_RETENTION_DAYS = '30';
    expect(getMessageRetentionDays()).toBe(90);
  });
});
