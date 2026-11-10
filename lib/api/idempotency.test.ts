import { describe, expect, it } from 'vitest';
import { idempotencyFingerprint, requireIdempotencyKey } from './idempotency';

function requestWithKey(key?: string): Request {
  return new Request('http://localhost/api/v1/requests', {
    method: 'POST',
    headers: key === undefined ? {} : { 'Idempotency-Key': key },
  });
}

/** Spec 015 §3 — the shared mechanism specs 018/020/021/036 will reuse. */
describe('Idempotency-Key header (spec 015 §3)', () => {
  it('returns the key when present', () => {
    expect(requireIdempotencyKey(requestWithKey('abc-123'))).toBe('abc-123');
  });

  it('is required: a missing or blank key is a VALIDATION_ERROR naming the header', () => {
    for (const key of [undefined, '', '   ']) {
      expect(() => requireIdempotencyKey(requestWithKey(key))).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
    try {
      requireIdempotencyKey(requestWithKey(undefined));
    } catch (err) {
      expect((err as { errors: { field: string }[] }).errors).toEqual([
        { field: 'Idempotency-Key', message: 'is required' },
      ]);
    }
  });

  it('trims surrounding whitespace rather than treating it as a different key', () => {
    expect(requireIdempotencyKey(requestWithKey('  abc-123  '))).toBe('abc-123');
  });

  it('rejects an unbounded key', () => {
    expect(() => requireIdempotencyKey(requestWithKey('x'.repeat(256)))).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});

describe('idempotency fingerprint (spec 015 §3)', () => {
  it('is stable for the same body', () => {
    const body = { serviceId: 's', urgency: 'normal' };
    expect(idempotencyFingerprint(body)).toBe(idempotencyFingerprint({ ...body }));
  });

  it('ignores property order at every depth — a reordered retry is the same request', () => {
    const a = { serviceId: 's', fieldValues: { b: 2, a: 1 }, urgency: 'normal' };
    const b = { urgency: 'normal', fieldValues: { a: 1, b: 2 }, serviceId: 's' };
    expect(idempotencyFingerprint(a)).toBe(idempotencyFingerprint(b));
  });

  it('treats an explicit undefined the same as an absent key', () => {
    expect(idempotencyFingerprint({ a: 1, budget: undefined })).toBe(idempotencyFingerprint({ a: 1 }));
  });

  it('does change when a value changes — a different body must conflict', () => {
    expect(idempotencyFingerprint({ description: 'one' })).not.toBe(idempotencyFingerprint({ description: 'two' }));
    expect(idempotencyFingerprint({ a: 1 })).not.toBe(idempotencyFingerprint({ a: '1' }));
    expect(idempotencyFingerprint({ a: 1 })).not.toBe(idempotencyFingerprint({ a: null }));
  });

  it('keeps array order significant — it carries meaning in a body', () => {
    expect(idempotencyFingerprint({ attachmentIds: ['a', 'b'] })).not.toBe(
      idempotencyFingerprint({ attachmentIds: ['b', 'a'] }),
    );
  });
});
