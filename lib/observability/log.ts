/**
 * Spec 046 §3.9 — the repository's existing structured-log convention made callable, NOT a new
 * logging system: one `JSON.stringify({ event, … })` line on `console.info|warn|error`, exactly
 * what every module already writes by hand. It adds two things callers kept forgetting:
 *
 *   - the request's `correlationId`, from spec 039's request context, when a request is running
 *     and the caller did not pass one (spec 004 correlation, cron runs via `withCronRoute`);
 *   - redaction: any field whose key names a secret, credential, payment instrument or message
 *     body is replaced by `"[REDACTED]"` at any depth, before serialisation.
 *
 * Destination is the hosting platform's runtime logs (spec 046 D-9); there is no vendor SDK here.
 * Existing hand-written `console.*(JSON.stringify(…))` call sites stay valid and are not migrated.
 */
import { getRequestCorrelationId } from '@/lib/audit/request-context';

export type LogLevel = 'info' | 'warn' | 'error';

export const REDACTED = '[REDACTED]';

/** Compared case-insensitively against a key with `_`/`-` removed (`account_number` → `accountnumber`). */
const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'otp',
  'totp',
  'pin',
  'cvv',
  'cardnumber',
  'pan',
  'iban',
  'accountnumber',
  'body',
  'messagebody',
  'content',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/** A copy of `value` with every sensitive key's value replaced, at any depth. Never mutates. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, seen);
  }
  return out;
}

const WRITERS: Record<LogLevel, (line: string) => void> = {
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** Writes one structured line. `fields` may not override `event`. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const correlationId = fields.correlationId ?? getRequestCorrelationId() ?? undefined;
  const payload = redact({ ...fields, ...(correlationId === undefined ? {} : { correlationId }) }) as Record<string, unknown>;
  delete payload.event;
  WRITERS[level](JSON.stringify({ event, ...payload }));
}
