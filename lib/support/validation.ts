/**
 * Spec 032 — parsing and normalization. PURE: no I/O, no logging, no database.
 *
 * Normalization runs BEFORE bounds are checked and before the idempotency fingerprint is taken, so
 * a retry differing only in whitespace replays rather than conflicting — the order specs
 * 028/029/030/031 already use.
 *
 * EVERY PARSER REJECTS UNKNOWN PROPERTIES. That is not tidiness: it is how AC-4's "priority is
 * never taken from the request body" is enforced at the edge. A client that sends
 * `{ ..., priority: 'critical' }` gets `400 VALIDATION_ERROR` naming the field, rather than having
 * it silently ignored and believing it worked.
 */
import { validationError } from '@/lib/api/errors';
import { isUuid } from '@/lib/offers/validation';
import {
  isSupportCategory,
  isSupportContextType,
  isSupportHandoffTarget,
  isSupportPriority,
  isSupportResolutionKind,
  isSupportTicketStatus,
  SUPPORT_CATEGORIES,
  SUPPORT_CONTEXT_TYPES,
  SUPPORT_HANDOFF_TARGETS,
  SUPPORT_PRIORITIES,
  type SupportCategory,
  type SupportContextType,
  type SupportHandoffTarget,
  type SupportPriority,
  type SupportResolutionKind,
  type SupportTicketStatus,
} from '@/lib/types/support';
import {
  MAX_ASSISTANT_QUESTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_SUPPORT_BODY_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MIN_REASON_LENGTH,
  MIN_SUBJECT_LENGTH,
} from './limits';

/**
 * Control characters that must never reach a stored support record: C0/C1 except LF and TAB, plus
 * the zero-width and bidi-override range. Identical to specs 029/030/031's rule — one
 * normalization story for the whole platform.
 */
// eslint-disable-next-line no-control-regex
const STRIPPED_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;

export function normalizeSupportText(input: string): string | null {
  const normalized = input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(STRIPPED_CHARACTERS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized.length === 0 ? null : normalized;
}

function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw validationError([{ field, message: 'is required' }]);
  const normalized = normalizeSupportText(value);
  if (normalized === null || normalized.length < min) {
    throw validationError([{ field, message: `must be at least ${min} characters` }]);
  }
  if (normalized.length > max) {
    throw validationError([{ field, message: `must be at most ${max} characters` }]);
  }
  return normalized;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([{ field: 'body', message: 'must be an object' }]);
  }
  return body as Record<string, unknown>;
}

/**
 * The gate AC-4 leans on. An unknown property is an error, not a shrug — see the module note.
 * `priority` is specifically named so the failure explains itself rather than looking like a typo.
 */
function rejectUnknownKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (allowed.includes(key)) continue;
    if (key === 'priority') {
      throw validationError([
        { field: 'priority', message: 'is not accepted: a ticket’s priority is set by the platform from its category' },
      ]);
    }
    throw validationError([{ field: key, message: 'is not a recognised field' }]);
  }
}

export interface ParsedCreateTicket {
  subject: string;
  description: string;
  category: SupportCategory;
  contextType: SupportContextType | null;
  contextId: string | null;
}

const CREATE_TICKET_KEYS = ['subject', 'description', 'category', 'contextType', 'contextId'] as const;

export function parseCreateTicketRequest(body: unknown): ParsedCreateTicket {
  const input = asObject(body);
  rejectUnknownKeys(input, CREATE_TICKET_KEYS);

  const subject = requireText(input.subject, 'subject', MIN_SUBJECT_LENGTH, MAX_SUBJECT_LENGTH);
  const description = requireText(input.description, 'description', MIN_DESCRIPTION_LENGTH, MAX_DESCRIPTION_LENGTH);

  if (!isSupportCategory(input.category)) {
    throw validationError([{ field: 'category', message: `must be one of: ${SUPPORT_CATEGORIES.join(', ')}` }]);
  }

  // Context is all-or-nothing, mirroring `support_tickets_context_pairing_ck`.
  const hasType = input.contextType !== undefined && input.contextType !== null;
  const hasId = input.contextId !== undefined && input.contextId !== null;
  if (hasType !== hasId) {
    throw validationError([{ field: 'contextId', message: 'contextType and contextId must be supplied together' }]);
  }
  if (!hasType) {
    return { subject, description, category: input.category, contextType: null, contextId: null };
  }
  if (!isSupportContextType(input.contextType)) {
    throw validationError([{ field: 'contextType', message: `must be one of: ${SUPPORT_CONTEXT_TYPES.join(', ')}` }]);
  }
  // A malformed uuid is a VALIDATION error here, before any lookup. Once a well-formed id reaches
  // resolution, every failure becomes the uniform `SUPPORT_CONTEXT_NOT_AVAILABLE` (AC-2).
  if (!isUuid(input.contextId)) {
    throw validationError([{ field: 'contextId', message: 'must be a uuid' }]);
  }

  return { subject, description, category: input.category, contextType: input.contextType, contextId: input.contextId };
}

export interface ParsedSupportMessage {
  body: string;
  requestsInformation: boolean;
}

const MESSAGE_KEYS = ['body', 'requestsInformation'] as const;

export function parseSupportMessageRequest(body: unknown): ParsedSupportMessage {
  const input = asObject(body);
  rejectUnknownKeys(input, MESSAGE_KEYS);

  const text = requireText(input.body, 'body', 1, MAX_SUPPORT_BODY_LENGTH);
  if (input.requestsInformation !== undefined && typeof input.requestsInformation !== 'boolean') {
    throw validationError([{ field: 'requestsInformation', message: 'must be a boolean' }]);
  }
  return { body: text, requestsInformation: input.requestsInformation === true };
}

const NOTE_KEYS = ['body'] as const;

export function parseSupportNoteRequest(body: unknown): { body: string } {
  const input = asObject(body);
  rejectUnknownKeys(input, NOTE_KEYS);
  return { body: requireText(input.body, 'body', 1, MAX_SUPPORT_BODY_LENGTH) };
}

function requireExpectedStatus(value: unknown): SupportTicketStatus {
  if (!isSupportTicketStatus(value)) {
    throw validationError([{ field: 'expectedStatus', message: 'must be a support ticket status' }]);
  }
  return value;
}

export interface ParsedAssign {
  assigneeUserId: string;
  expectedStatus: SupportTicketStatus;
}

const ASSIGN_KEYS = ['assigneeUserId', 'expectedStatus'] as const;

export function parseAssignRequest(body: unknown): ParsedAssign {
  const input = asObject(body);
  rejectUnknownKeys(input, ASSIGN_KEYS);
  if (!isUuid(input.assigneeUserId)) {
    throw validationError([{ field: 'assigneeUserId', message: 'must be a uuid' }]);
  }
  return { assigneeUserId: input.assigneeUserId, expectedStatus: requireExpectedStatus(input.expectedStatus) };
}

export interface ParsedPriorityChange {
  priority: SupportPriority;
  reason: string;
  expectedStatus: SupportTicketStatus;
}

const PRIORITY_KEYS = ['priority', 'reason', 'expectedStatus'] as const;

/**
 * The ONE parser that accepts `priority` — the admin triage route, behind `support/triage`.
 * It does not go through `rejectUnknownKeys`'s priority special case, because here it is the point.
 */
export function parsePriorityChangeRequest(body: unknown): ParsedPriorityChange {
  const input = asObject(body);
  for (const key of Object.keys(input)) {
    if (!(PRIORITY_KEYS as readonly string[]).includes(key)) {
      throw validationError([{ field: key, message: 'is not a recognised field' }]);
    }
  }
  if (!isSupportPriority(input.priority)) {
    throw validationError([{ field: 'priority', message: `must be one of: ${SUPPORT_PRIORITIES.join(', ')}` }]);
  }
  return {
    priority: input.priority,
    reason: requireText(input.reason, 'reason', MIN_REASON_LENGTH, MAX_REASON_LENGTH),
    expectedStatus: requireExpectedStatus(input.expectedStatus),
  };
}

export interface ParsedResolve {
  resolutionKind: SupportResolutionKind;
  reason: string;
  handoffTarget: SupportHandoffTarget | null;
  expectedStatus: SupportTicketStatus;
}

const RESOLVE_KEYS = ['resolutionKind', 'reason', 'handoffTarget', 'expectedStatus'] as const;

export function parseResolveRequest(body: unknown): ParsedResolve {
  const input = asObject(body);
  rejectUnknownKeys(input, RESOLVE_KEYS);

  if (!isSupportResolutionKind(input.resolutionKind)) {
    throw validationError([{ field: 'resolutionKind', message: 'must be answered, handed_off or not_actionable' }]);
  }
  const reason = requireText(input.reason, 'reason', MIN_REASON_LENGTH, MAX_REASON_LENGTH);

  const hasTarget = input.handoffTarget !== undefined && input.handoffTarget !== null;
  if (hasTarget && !isSupportHandoffTarget(input.handoffTarget)) {
    throw validationError([{ field: 'handoffTarget', message: `must be one of: ${SUPPORT_HANDOFF_TARGETS.join(', ')}` }]);
  }
  // Mirrors `support_tickets_handoff_pairing_ck` — the database enforces it independently.
  if (input.resolutionKind === 'handed_off' && !hasTarget) {
    throw validationError([{ field: 'handoffTarget', message: 'is required when resolving as handed_off' }]);
  }
  if (input.resolutionKind !== 'handed_off' && hasTarget) {
    throw validationError([{ field: 'handoffTarget', message: 'is only valid when resolving as handed_off' }]);
  }

  return {
    resolutionKind: input.resolutionKind,
    reason,
    handoffTarget: hasTarget ? (input.handoffTarget as SupportHandoffTarget) : null,
    expectedStatus: requireExpectedStatus(input.expectedStatus),
  };
}

export interface ParsedHandOff {
  target: SupportHandoffTarget;
  reason: string;
  targetUserId: string | null;
  disputeId: string | null;
  expectedStatus: SupportTicketStatus;
}

const HANDOFF_KEYS = ['target', 'reason', 'targetUserId', 'disputeId', 'expectedStatus'] as const;

export function parseHandOffRequest(body: unknown): ParsedHandOff {
  const input = asObject(body);
  rejectUnknownKeys(input, HANDOFF_KEYS);

  if (!isSupportHandoffTarget(input.target)) {
    throw validationError([{ field: 'target', message: `must be one of: ${SUPPORT_HANDOFF_TARGETS.join(', ')}` }]);
  }
  const reason = requireText(input.reason, 'reason', MIN_REASON_LENGTH, MAX_REASON_LENGTH);

  let targetUserId: string | null = null;
  let disputeId: string | null = null;

  if (input.target === 'safety') {
    if (!isUuid(input.targetUserId)) {
      throw validationError([{ field: 'targetUserId', message: 'is required when handing off to safety' }]);
    }
    targetUserId = input.targetUserId;
  } else if (input.target === 'dispute') {
    if (!isUuid(input.disputeId)) {
      throw validationError([{ field: 'disputeId', message: 'is required when handing off to a dispute' }]);
    }
    disputeId = input.disputeId;
  }

  return { target: input.target, reason, targetUserId, disputeId, expectedStatus: requireExpectedStatus(input.expectedStatus) };
}

const ASSISTANT_KEYS = ['question'] as const;

/** AC-1's request. `{ question }` and nothing else; the bound is spec 025's, per §3. */
export function parseAssistantRequest(body: unknown): { question: string } {
  const input = asObject(body);
  rejectUnknownKeys(input, ASSISTANT_KEYS);
  return { question: requireText(input.question, 'question', 1, MAX_ASSISTANT_QUESTION_LENGTH) };
}
