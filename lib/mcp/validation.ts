/**
 * Spec 035 §3 "Validation" — the strict-schema helpers every tool's `validate` is built from.
 *
 * This repository has no schema library (no zod/yup/valibot), so validation is hand-written, the
 * convention spec 004's `validationError` established. Two rules make it a defense and not just a
 * type cast (master spec §93):
 *
 *   1. UNEXPECTED FIELDS ARE REJECTED, never ignored. An ignored field is an injection surface:
 *      a model talked into emitting `{"bookingId": "…", "userId": "someone-else"}` must fail
 *      loudly rather than have the extra key silently dropped and the call proceed.
 *   2. Every value is DATA. Nothing read here is ever interpreted as an instruction, and no field
 *      read here can name the caller: identity, mode and admin status come from the session
 *      (`McpAuthContext`), never from input.
 */
import { mcpSchemaValidationFailedError } from './errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Field names that describe the CALLER rather than the call. Present in input, they are always a
 * tampering attempt — the pipeline reads identity from the session only (AC-2) — so they are
 * rejected by name even when a tool would otherwise allow an extra field.
 */
export const IDENTITY_FIELDS = ['userId', 'user_id', 'sessionId', 'session_id', 'isAdmin', 'is_admin', 'activeMode', 'active_mode'] as const;

export function fail(field: string, message: string): never {
  throw mcpSchemaValidationFailedError([{ field, message }]);
}

/** The input must be a plain object: no array, no null, no primitive, no class instance. */
export function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('input', 'must be an object');
  return raw as Record<string, unknown>;
}

/**
 * Rejects any key the tool did not declare, and any identity field in any case. Call this FIRST in
 * every `validate`, before reading a single value.
 */
export function requireExactFields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const input = requireObject(raw);
  for (const key of Object.keys(input)) {
    if ((IDENTITY_FIELDS as readonly string[]).includes(key)) fail(key, 'is never accepted from tool input');
    if (!allowed.includes(key)) fail(key, 'is not an accepted field');
  }
  return input;
}

export function requireString(input: Record<string, unknown>, field: string, options?: { maxLength?: number }): string {
  const value = input[field];
  if (typeof value !== 'string') fail(field, 'must be a string');
  const trimmed = (value as string).trim();
  if (trimmed.length === 0) fail(field, 'must not be empty');
  if (options?.maxLength !== undefined && trimmed.length > options.maxLength) {
    fail(field, `must be at most ${options.maxLength} characters`);
  }
  return trimmed;
}

export function requireUuid(input: Record<string, unknown>, field: string): string {
  const value = requireString(input, field);
  if (!UUID_PATTERN.test(value)) fail(field, 'must be a UUID');
  return value;
}

export function requireEnum<T extends string>(input: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = requireString(input, field);
  if (!allowed.includes(value as T)) fail(field, 'is not one of the accepted values');
  return value as T;
}

/** An integer in minor units — the repository's money rule (spec 003 AC-1): never a float. */
export function requireIntegerMinorUnits(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, 'must be an integer in minor units');
  if ((value as number) < 0) fail(field, 'must not be negative');
  return value as number;
}

export function optionalUuid(input: Record<string, unknown>, field: string): string | undefined {
  if (input[field] === undefined) return undefined;
  return requireUuid(input, field);
}
