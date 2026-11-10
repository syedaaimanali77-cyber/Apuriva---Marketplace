import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { formatMessageCursor, parseMessageCursor } from './cursor';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

/** Spec 025 §3 "Incremental reads for live update" — the `after` cursor. */
describe('message cursor (spec 025 §3)', () => {
  it('round-trips a message into a cursor and back', () => {
    const createdAt = '2026-09-17T10:15:30.123Z';
    const cursor = parseMessageCursor(formatMessageCursor({ createdAt, id: ID }));
    expect(cursor.createdAt.toISOString()).toBe(createdAt);
    expect(cursor.id).toBe(ID);
  });

  it.each([
    ['empty', ''],
    ['no separator', `2026-09-17T10:15:30.123Z${ID}`],
    ['not a uuid', '2026-09-17T10:15:30.123Z|not-a-uuid'],
    ['not a timestamp', `yesterday|${ID}`],
    ['non-UTC timestamp', `2026-09-17T10:15:30+05:00|${ID}`],
    ['impossible date', `2026-13-45T10:15:30.123Z|${ID}`],
  ])('rejects a malformed cursor (%s) with 400 VALIDATION_ERROR — never silently ignored', (_label, raw) => {
    try {
      parseMessageCursor(raw);
      throw new Error('expected a validation error');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRouteError);
      expect((err as ApiRouteError).status).toBe(400);
      expect((err as ApiRouteError).errors).toEqual([expect.objectContaining({ field: 'after' })]);
    }
  });
});
