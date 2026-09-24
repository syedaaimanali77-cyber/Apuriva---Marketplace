/**
 * Spec 036 — ONE declaration of a tool's input fields, from which everything else is derived so the
 * four uses can never disagree:
 *
 *   1. strict validation (spec 035 §3: unexpected fields REJECTED, identity fields rejected by name);
 *   2. the minimal REDACTED `ai_tool_calls.input_params` (§4, AC-9);
 *   3. the confirmation BINDING rows in spec 035's `mcp_confirmation_parameters` (§3 contract 1);
 *   4. the model-facing catalogue (field names and value kinds only).
 *
 * Kinds are split by what may be persisted. Only SAFE kinds — IDs, enum values, minor-unit amounts,
 * currency codes, timestamps/dates and booleans — are ever stored as values or bound into a
 * confirmation. Every other kind (free text, plain numbers such as coordinates or page sizes) is
 * recorded by field NAME only, marked redacted, and can never be part of a confirmation binding.
 */
import type { McpBoundParameter } from '@/lib/mcp';
import { requireEnum, requireExactFields, requireIntegerMinorUnits, requireString, requireUuid } from '@/lib/mcp';
import { fail } from '@/lib/mcp/validation';
import { isValidDateString } from '@/lib/availability/timezone';

export type ToolFieldKind =
  | 'uuid'
  | 'enum'
  | 'timestamp'
  | 'date'
  | 'boolean'
  | 'minorUnits'
  | 'currency'
  | 'integer'
  | 'number'
  | 'text';

export interface ToolField {
  name: string;
  kind: ToolFieldKind;
  required: boolean;
  /** `enum` only: the closed list. */
  values?: readonly string[];
  /** `integer` only: inclusive bounds. */
  min?: number;
  max?: number;
}

/** The kinds whose VALUES are safe to persist and to bind into a confirmation (§4, D-16). */
const SAFE_KINDS: ReadonlySet<ToolFieldKind> = new Set(['uuid', 'enum', 'timestamp', 'date', 'boolean', 'minorUnits', 'currency']);

/** The marker recorded in place of any value that may not be persisted (§4: "by field name only"). */
export const REDACTED = '[redacted]';

export function isSafeKind(kind: ToolFieldKind): boolean {
  return SAFE_KINDS.has(kind);
}

/**
 * Strict validation. Unknown and identity fields are rejected first (spec 035's
 * `requireExactFields`), then each declared field by its kind. An optional field may be absent or
 * `null`; both mean "not supplied". Returns only the supplied fields, normalized.
 */
export function validateToolInput(raw: unknown, fields: readonly ToolField[]): Record<string, unknown> {
  const input = requireExactFields(raw ?? {}, fields.map((field) => field.name));
  const out: Record<string, unknown> = {};

  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined || value === null) {
      if (field.required) fail(field.name, 'is required');
      continue;
    }
    out[field.name] = validateValue(input, field);
  }
  return out;
}

function validateValue(input: Record<string, unknown>, field: ToolField): unknown {
  switch (field.kind) {
    case 'uuid':
      return requireUuid(input, field.name).toLowerCase();
    case 'enum':
      return requireEnum(input, field.name, field.values ?? []);
    case 'timestamp': {
      const value = requireString(input, field.name);
      const instant = Date.parse(value);
      if (!Number.isFinite(instant)) fail(field.name, 'must be an ISO 8601 date-time');
      return new Date(instant).toISOString();
    }
    case 'date': {
      const value = requireString(input, field.name);
      if (!isValidDateString(value)) fail(field.name, 'must be a date (YYYY-MM-DD)');
      return value;
    }
    case 'boolean': {
      const value = input[field.name];
      if (typeof value !== 'boolean') fail(field.name, 'must be true or false');
      return value;
    }
    case 'minorUnits':
      return requireIntegerMinorUnits(input, field.name);
    case 'currency': {
      const value = requireString(input, field.name).toUpperCase();
      if (!/^[A-Z]{3}$/.test(value)) fail(field.name, 'must be a three-letter ISO-4217 code');
      return value;
    }
    case 'integer': {
      const value = input[field.name];
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(field.name, 'must be an integer');
      if (field.min !== undefined && (value as number) < field.min) fail(field.name, `must be at least ${field.min}`);
      if (field.max !== undefined && (value as number) > field.max) fail(field.name, `must be at most ${field.max}`);
      return value;
    }
    case 'number': {
      const value = input[field.name];
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(field.name, 'must be a number');
      return value;
    }
    case 'text':
      return requireString(input, field.name);
  }
}

/**
 * The minimal redacted structure of §4 (AC-9): a SAFE value as it is; anything else by field name
 * only. A field that was not supplied is absent.
 */
export function redactInput(input: Record<string, unknown> | undefined, fields: readonly ToolField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  for (const field of fields) {
    if (!(field.name in input)) continue;
    out[field.name] = isSafeKind(field.kind) ? input[field.name] : REDACTED;
  }
  return out;
}

/**
 * The BINDING rows of a confirmation (§3 contract 1): one per supplied field, labelled with the
 * field's own name, valued with the string form of the validated value. Only safe kinds exist in a
 * confirmable tool (enforced at registration), so no free text is ever bound.
 */
export function encodeBinding(input: Record<string, unknown>, fields: readonly ToolField[]): McpBoundParameter[] {
  return fields.filter((field) => field.name in input).map((field) => ({ label: field.name, value: String(input[field.name]) }));
}

/** Restores the raw input from binding rows; the tool's `validate` then re-checks it in full. */
export function decodeBinding(rows: readonly McpBoundParameter[], fields: readonly ToolField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const row = rows.find((candidate) => candidate.label === field.name);
    if (!row) continue;
    if (field.kind === 'boolean') out[field.name] = row.value === 'true';
    else if (field.kind === 'minorUnits' || field.kind === 'integer' || field.kind === 'number') out[field.name] = Number(row.value);
    else out[field.name] = row.value;
  }
  return out;
}

/** The model-facing description: names and value kinds only — no logic, no validators. */
export function describeFields(fields: readonly ToolField[]): Array<{ name: string; kind: string; required: boolean; values?: readonly string[] }> {
  return fields.map((field) => ({
    name: field.name,
    kind: field.kind,
    required: field.required,
    ...(field.values ? { values: field.values } : {}),
  }));
}
