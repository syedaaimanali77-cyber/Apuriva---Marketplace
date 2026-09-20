/**
 * Spec 031 — parsing and normalization. PURE: no I/O, no logging, no database.
 *
 * Normalization runs BEFORE bounds are checked and before the idempotency fingerprint is taken, so
 * a retry differing only in whitespace replays rather than conflicting — the order specs
 * 028/029/030 already use. The character rule is spec 030's verbatim: one normalization story for
 * the whole platform, not a second one invented here.
 *
 * MONEY VALIDATION HERE IS SHAPE-ONLY (DECIDED-5). `parseResolveRequest` checks that a proposed
 * amount is a positive integer and that its currency is a three-letter ISO-4217 code. It does NOT
 * check it against the payment — that comparison needs the refundable position, which is spec 022's
 * `readRefundablePosition()` to compute and `lib/disputes/resolve.ts` to consult under the lock.
 */
import { validationError } from '@/lib/api/errors';
import { isUuid } from '@/lib/offers/validation';
import {
  isDisputeAppealOutcome,
  isDisputeDecision,
  type DisputeAppealOutcome,
  type DisputeDecision,
} from '@/lib/types/disputes';
import {
  MAX_DISPUTE_REASON_LENGTH,
  MAX_DISPUTE_REASONING_LENGTH,
  MIN_DISPUTE_REASON_LENGTH,
  MIN_DISPUTE_REASONING_LENGTH,
} from './limits';

/**
 * Control characters that must never reach a stored dispute record: C0/C1 except LF and TAB, plus
 * the zero-width and bidi-override range. Identical to spec 029's and spec 030's rule.
 */
// eslint-disable-next-line no-control-regex
const STRIPPED_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;

export function normalizeDisputeText(input: string): string | null {
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
  const normalized = normalizeDisputeText(value);
  if (normalized === null || normalized.length < min) {
    throw validationError([{ field, message: `must be at least ${min} characters` }]);
  }
  if (normalized.length > max) {
    throw validationError([{ field, message: `must be at most ${max} characters` }]);
  }
  return normalized;
}

export interface ParsedOpenDispute {
  reason: string;
}

export function parseOpenDisputeRequest(body: unknown): ParsedOpenDispute {
  const input = (body ?? {}) as Record<string, unknown>;
  return { reason: requireText(input.reason, 'reason', MIN_DISPUTE_REASON_LENGTH, MAX_DISPUTE_REASON_LENGTH) };
}

export interface ParsedDisputeMessage {
  body: string;
}

/**
 * A message body's lower bound is 1, not 10: "yes", "agreed" and "that is not what happened" are
 * all legitimate contributions to an argument, and `dispute_messages_body_length_ck` mirrors it.
 */
export function parseDisputeMessageRequest(body: unknown): ParsedDisputeMessage {
  const input = (body ?? {}) as Record<string, unknown>;
  return { body: requireText(input.body, 'body', 1, 2000) };
}

export interface ParsedEvidenceLink {
  fileAssetId: string;
}

export function parseEvidenceLinkRequest(body: unknown): ParsedEvidenceLink {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.fileAssetId !== 'string' || !isUuid(input.fileAssetId)) {
    throw validationError([{ field: 'fileAssetId', message: 'is required and must be a file asset id' }]);
  }
  return { fileAssetId: input.fileAssetId };
}

export interface ParsedResolve {
  decision: DisputeDecision;
  reasoning: string;
  proposedRefundAmountMinorUnits: number | null;
  proposedRefundCurrencyCode: string | null;
}

const REFUND_DECISIONS: readonly DisputeDecision[] = ['refund_customer', 'partial_refund_customer'];

/**
 * AC-3 + AC-5.
 *
 * The pairing is enforced in BOTH directions and mirrored by `dispute_resolutions_refund_pairing_ck`:
 * a refund decision must carry an amount, and a non-refund decision must not. A resolution that
 * said "refund the customer" with no number would be a promise nobody could act on, and one that
 * attached a number to `no_action` would be a number nobody had decided to pay.
 */
export function parseResolveRequest(body: unknown): ParsedResolve {
  const input = (body ?? {}) as Record<string, unknown>;

  if (!isDisputeDecision(input.decision)) {
    throw validationError([{ field: 'decision', message: 'is required and must be a valid dispute decision' }]);
  }
  const decision = input.decision;
  const reasoning = requireText(input.reasoning, 'reasoning', MIN_DISPUTE_REASONING_LENGTH, MAX_DISPUTE_REASONING_LENGTH);

  const wantsRefund = REFUND_DECISIONS.includes(decision);
  const amount = input.proposedRefundAmountMinorUnits;
  const currency = typeof input.proposedRefundCurrencyCode === 'string' ? input.proposedRefundCurrencyCode.trim().toUpperCase() : null;

  if (!wantsRefund) {
    if (amount !== undefined && amount !== null) {
      throw validationError([
        { field: 'proposedRefundAmountMinorUnits', message: `must be omitted for the ${decision} decision` },
      ]);
    }
    return { decision, reasoning, proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null };
  }

  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw validationError([
      { field: 'proposedRefundAmountMinorUnits', message: 'is required and must be a positive whole number of minor units' },
    ]);
  }
  if (currency === null || !/^[A-Z]{3}$/.test(currency)) {
    throw validationError([
      { field: 'proposedRefundCurrencyCode', message: 'is required and must be a three-letter ISO-4217 code' },
    ]);
  }
  return { decision, reasoning, proposedRefundAmountMinorUnits: amount, proposedRefundCurrencyCode: currency };
}

export interface ParsedAppeal {
  reason: string;
}

export function parseAppealRequest(body: unknown): ParsedAppeal {
  const input = (body ?? {}) as Record<string, unknown>;
  return { reason: requireText(input.reason, 'reason', MIN_DISPUTE_REASON_LENGTH, MAX_DISPUTE_REASON_LENGTH) };
}

export interface ParsedAppealDecision {
  outcome: DisputeAppealOutcome;
  reasoning: string;
}

export function parseAppealDecisionRequest(body: unknown): ParsedAppealDecision {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!isDisputeAppealOutcome(input.outcome)) {
    throw validationError([{ field: 'outcome', message: 'is required and must be upheld, overturned or partially_upheld' }]);
  }
  return {
    outcome: input.outcome,
    reasoning: requireText(input.reasoning, 'reasoning', MIN_DISPUTE_REASONING_LENGTH, MAX_DISPUTE_REASONING_LENGTH),
  };
}

export interface ParsedLinkRefund {
  adminActionId: string;
}

export function parseLinkRefundRequest(body: unknown): ParsedLinkRefund {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.adminActionId !== 'string' || !isUuid(input.adminActionId)) {
    throw validationError([{ field: 'adminActionId', message: 'is required and must be an admin action id' }]);
  }
  return { adminActionId: input.adminActionId };
}

export interface ParsedLegalHold {
  legalHold: boolean;
  reason: string;
}

export function parseLegalHoldRequest(body: unknown): ParsedLegalHold {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.legalHold !== 'boolean') {
    throw validationError([{ field: 'legalHold', message: 'is required and must be a boolean' }]);
  }
  return {
    legalHold: input.legalHold,
    reason: requireText(input.reason, 'reason', MIN_DISPUTE_REASONING_LENGTH, MAX_DISPUTE_REASONING_LENGTH),
  };
}

export interface ParsedSafetyEscalation {
  targetUserId: string;
  category: string;
  reason: string;
}

/**
 * DECIDED-9 — the payload handed to spec 030's own creation path.
 *
 * `category` is validated by spec 030, not here: its vocabulary is spec 030's to own and this spec
 * must not fork a copy that could drift.
 */
export function parseSafetyEscalationRequest(body: unknown): ParsedSafetyEscalation {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.targetUserId !== 'string' || !isUuid(input.targetUserId)) {
    throw validationError([{ field: 'targetUserId', message: 'is required and must be a user id' }]);
  }
  if (typeof input.category !== 'string' || input.category.trim().length === 0) {
    throw validationError([{ field: 'category', message: 'is required' }]);
  }
  return {
    targetUserId: input.targetUserId,
    category: input.category.trim(),
    reason: requireText(input.reason, 'reason', MIN_DISPUTE_REASONING_LENGTH, MAX_DISPUTE_REASONING_LENGTH),
  };
}
