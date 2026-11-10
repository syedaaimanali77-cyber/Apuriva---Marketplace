import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '@/lib/audit/request-context';
import { isSensitiveKey, logEvent, redact, REDACTED } from './log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('redact (spec 046 §3.9)', () => {
  it('replaces sensitive keys at any depth, case-insensitively and ignoring _ and -', () => {
    const input = {
      event: 'x',
      Password: 'hunter2',
      nested: { account_number: '123', list: [{ CVV: '999', ok: 1 }], messageBody: 'hi' },
      'card-number': '4242',
      Authorization: 'Bearer abc',
    };
    expect(redact(input)).toEqual({
      event: 'x',
      Password: REDACTED,
      nested: { account_number: REDACTED, list: [{ CVV: REDACTED, ok: 1 }], messageBody: REDACTED },
      'card-number': REDACTED,
      Authorization: REDACTED,
    });
  });

  it('keeps non-sensitive keys and never mutates its input', () => {
    const input = { job: 'payment-sweep', counts: { processed: 3 }, token: 't' };
    const out = redact(input);
    expect(out).toEqual({ job: 'payment-sweep', counts: { processed: 3 }, token: REDACTED });
    expect(input.token).toBe('t');
  });

  it('passes primitives, null and dates through, and survives cycles', () => {
    expect(redact(5)).toBe(5);
    expect(redact(null)).toBeNull();
    const when = new Date(0);
    expect(redact(when)).toBe(when);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ a: 1, self: '[Circular]' });
  });

  it.each(['secret', 'OTP', 'totp', 'pin', 'pan', 'iban', 'cookie', 'content', 'body'])('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['job', 'status', 'durationMs', 'correlationId', 'panel'])('%s is not sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('logEvent (spec 046 §3.9)', () => {
  it('writes one JSON line on the level-matching console method, event first', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    logEvent('info', 'a.info', { n: 1 });
    logEvent('warn', 'a.warn');
    logEvent('error', 'a.error', { password: 'x' });

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({ event: 'a.info', n: 1 });
    expect(Object.keys(JSON.parse(info.mock.calls[0]![0] as string))[0]).toBe('event');
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({ event: 'a.warn' });
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toEqual({ event: 'a.error', password: REDACTED });
  });

  it("adds the request context's correlationId when the caller gave none", () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    runWithRequestContext({ correlationId: 'corr-1' }, () => logEvent('info', 'in.request'));
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({ event: 'in.request', correlationId: 'corr-1' });
  });

  it('keeps an explicit correlationId and adds none outside a request', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    runWithRequestContext({ correlationId: 'ctx' }, () => logEvent('info', 'explicit', { correlationId: 'given' }));
    logEvent('info', 'outside');
    expect(JSON.parse(info.mock.calls[0]![0] as string).correlationId).toBe('given');
    expect(JSON.parse(info.mock.calls[1]![0] as string)).toEqual({ event: 'outside' });
  });

  it('never lets a field override the event name', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logEvent('info', 'real.event', { event: 'spoofed' } as Record<string, unknown>);
    expect(JSON.parse(info.mock.calls[0]![0] as string).event).toBe('real.event');
  });
});
