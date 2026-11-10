import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { MCP_SCHEMA_VALIDATION_FAILED } from './errors';
import {
  IDENTITY_FIELDS,
  requireEnum,
  requireExactFields,
  requireIntegerMinorUnits,
  requireObject,
  requireString,
  requireUuid,
} from './validation';

/** The message lives in spec 004's field-level `errors[]`; the top-level text never echoes input. */
function fieldError(call: () => unknown): { field: string; message: string } {
  try {
    call();
  } catch (err) {
    const error = err as ApiRouteError;
    expect(error.code).toBe(MCP_SCHEMA_VALIDATION_FAILED);
    return error.errors![0]!;
  }
  throw new Error('expected validation to throw');
}

/** Spec 035 §3 "Validation" — strict schemas (master spec §88, §93). */
describe('spec 035 strict input validation', () => {
  it('rejects anything that is not a plain object', () => {
    for (const raw of [null, undefined, 42, 'text', [], true]) {
      expect(() => requireObject(raw)).toThrow(ApiRouteError);
    }
  });

  it('rejects an unexpected field instead of ignoring it', () => {
    expect(fieldError(() => requireExactFields({ bookingId: 'x', extra: 'y' }, ['bookingId']))).toEqual({
      field: 'extra',
      message: 'is not an accepted field',
    });
  });

  it('rejects every identity field by name — identity comes from the session, never from input', () => {
    for (const field of IDENTITY_FIELDS) {
      expect(fieldError(() => requireExactFields({ [field]: 'someone-else' }, [field])).message).toBe(
        'is never accepted from tool input',
      );
    }
  });

  it('fails with MCP_SCHEMA_VALIDATION_FAILED at 400, naming the field but never echoing its value', () => {
    try {
      requireExactFields({ secretToken: 'sk-live-do-not-echo' }, ['note']);
      expect.unreachable('validation should have thrown');
    } catch (err) {
      const error = err as ApiRouteError;
      expect(error.code).toBe(MCP_SCHEMA_VALIDATION_FAILED);
      expect(error.status).toBe(400);
      expect(error.errors).toEqual([{ field: 'secretToken', message: 'is not an accepted field' }]);
      expect(JSON.stringify(error)).not.toContain('sk-live-do-not-echo');
      expect(error.message).not.toContain('sk-live-do-not-echo');
    }
  });

  it('validates strings, UUIDs, enums and integer minor units', () => {
    const input = requireExactFields(
      { note: '  hello  ', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', mode: 'customer', amountMinorUnits: 1500 },
      ['note', 'id', 'mode', 'amountMinorUnits'],
    );

    expect(requireString(input, 'note')).toBe('hello');
    expect(requireUuid(input, 'id')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(requireEnum(input, 'mode', ['customer', 'provider'] as const)).toBe('customer');
    expect(requireIntegerMinorUnits(input, 'amountMinorUnits')).toBe(1500);
  });

  it('refuses a non-integer amount — money is minor units, never a float (spec 003 AC-1)', () => {
    expect(fieldError(() => requireIntegerMinorUnits({ amountMinorUnits: 15.5 }, 'amountMinorUnits')).message).toBe(
      'must be an integer in minor units',
    );
  });

  it('refuses an empty string, a malformed UUID and a value outside an enum', () => {
    expect(fieldError(() => requireString({ note: '   ' }, 'note')).message).toBe('must not be empty');
    expect(fieldError(() => requireUuid({ id: 'not-a-uuid' }, 'id')).message).toBe('must be a UUID');
    expect(fieldError(() => requireEnum({ mode: 'admin' }, 'mode', ['customer', 'provider'] as const)).message).toBe(
      'is not one of the accepted values',
    );
  });
});
