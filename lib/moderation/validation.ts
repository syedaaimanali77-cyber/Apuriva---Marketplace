/**
 * Spec 038 §3.14 — request parsing. Only whitelisted fields are ever read, and every failure is the
 * repository's `400 VALIDATION_ERROR` naming the field (the draft's `REASON_REQUIRED` is not a code
 * here, per §3.15).
 */
import { validationError } from '@/lib/api/errors';
import { isUuid } from '@/lib/offers/validation';
import { MODERATION_ACTION_TYPES, MODERATION_SCOPES, FRAUD_SIGNAL_STATUSES } from '@/lib/db/schema';
import type {
  CreateModerationActionRequest,
  DecideModerationAppealRequest,
  FraudSignalStatus,
  ModerationActionType,
  ModerationScope,
  RefundTreatment,
} from '@/lib/types/moderation';
import { MAX_APPEAL_STATEMENT_LENGTH, MAX_REASON_LENGTH, MAX_USER_MESSAGE_LENGTH } from './catalogue';

type FieldError = { field: string; message: string };

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function requiredText(value: unknown, field: string, max: number, errors: FieldError[]): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) errors.push({ field, message: 'is required' });
  else if (text.length > max) errors.push({ field, message: `must be at most ${max} characters` });
  return text;
}

function optionalUuid(value: unknown, field: string, errors: FieldError[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !isUuid(value)) {
    errors.push({ field, message: 'must be a UUID' });
    return undefined;
  }
  return value;
}

export function parseCreateModerationActionRequest(body: unknown): CreateModerationActionRequest {
  const input = asRecord(body);
  const errors: FieldError[] = [];

  const actionType = input.actionType as ModerationActionType;
  if (!(MODERATION_ACTION_TYPES as readonly unknown[]).includes(actionType)) {
    errors.push({ field: 'actionType', message: `must be one of ${MODERATION_ACTION_TYPES.join(', ')}` });
  }
  const scope = input.scope as ModerationScope;
  if (!(MODERATION_SCOPES as readonly unknown[]).includes(scope)) {
    errors.push({ field: 'scope', message: `must be one of ${MODERATION_SCOPES.join(', ')}` });
  }

  const targetUserId = typeof input.targetUserId === 'string' && isUuid(input.targetUserId) ? input.targetUserId : '';
  if (!targetUserId) errors.push({ field: 'targetUserId', message: 'must be a UUID' });
  const providerProfileId = optionalUuid(input.providerProfileId, 'providerProfileId', errors);
  const bookingId = optionalUuid(input.bookingId, 'bookingId', errors);
  const originFraudSignalId = optionalUuid(input.originFraudSignalId, 'originFraudSignalId', errors);

  const reason = requiredText(input.reason, 'reason', MAX_REASON_LENGTH, errors);

  let userMessage: string | undefined;
  if (input.userMessage !== undefined && input.userMessage !== null) {
    if (typeof input.userMessage !== 'string') errors.push({ field: 'userMessage', message: 'must be a string' });
    else if (input.userMessage.trim().length > MAX_USER_MESSAGE_LENGTH) {
      errors.push({ field: 'userMessage', message: `must be at most ${MAX_USER_MESSAGE_LENGTH} characters` });
    } else if (input.userMessage.trim().length > 0) userMessage = input.userMessage.trim();
  }

  let refundTreatment: RefundTreatment | undefined;
  if (input.refundTreatment !== undefined && input.refundTreatment !== null) {
    if (input.refundTreatment !== 'policy' && input.refundTreatment !== 'full') {
      errors.push({ field: 'refundTreatment', message: 'must be one of policy, full' });
    } else refundTreatment = input.refundTreatment;
  }

  // §3.14 scope/target pairing — the same rules `moderation_actions_scope_target_ck` enforces.
  if (actionType === 'booking_intervention') {
    if (scope !== 'booking') errors.push({ field: 'scope', message: 'must be booking for booking_intervention' });
    if (!bookingId) errors.push({ field: 'bookingId', message: 'is required for booking_intervention' });
    if (!refundTreatment) errors.push({ field: 'refundTreatment', message: 'is required for booking_intervention' });
  } else {
    if (scope === 'booking') errors.push({ field: 'scope', message: 'booking is only valid for booking_intervention' });
    if (bookingId) errors.push({ field: 'bookingId', message: 'is only valid for booking_intervention' });
    if (refundTreatment) errors.push({ field: 'refundTreatment', message: 'is only valid for booking_intervention' });
  }
  if (actionType === 'payout_freeze' && scope !== 'provider_profile') {
    errors.push({ field: 'scope', message: 'must be provider_profile for payout_freeze' });
  }
  if (scope === 'provider_profile' && !providerProfileId) {
    errors.push({ field: 'providerProfileId', message: 'is required for scope provider_profile' });
  }
  if (scope === 'account' && providerProfileId) {
    errors.push({ field: 'providerProfileId', message: 'is only valid for scope provider_profile' });
  }

  if (errors.length > 0) throw validationError(errors);
  return { actionType, scope, targetUserId, providerProfileId, bookingId, refundTreatment, reason, userMessage, originFraudSignalId };
}

export function parseReasonOnly(body: unknown): { reason: string } {
  const errors: FieldError[] = [];
  const reason = requiredText(asRecord(body).reason, 'reason', MAX_REASON_LENGTH, errors);
  if (errors.length > 0) throw validationError(errors);
  return { reason };
}

export function parseTriageRequest(body: unknown): { expectedStatus: FraudSignalStatus; reason: string } {
  const input = asRecord(body);
  const errors: FieldError[] = [];
  const expectedStatus = input.expectedStatus as FraudSignalStatus;
  if (!(FRAUD_SIGNAL_STATUSES as readonly unknown[]).includes(expectedStatus)) {
    errors.push({ field: 'expectedStatus', message: `must be one of ${FRAUD_SIGNAL_STATUSES.join(', ')}` });
  }
  const reason = requiredText(input.reason, 'reason', MAX_REASON_LENGTH, errors);
  if (errors.length > 0) throw validationError(errors);
  return { expectedStatus, reason };
}

export function parseAppealRequest(body: unknown): { statement: string } {
  const errors: FieldError[] = [];
  const statement = requiredText(asRecord(body).statement, 'statement', MAX_APPEAL_STATEMENT_LENGTH, errors);
  if (errors.length > 0) throw validationError(errors);
  return { statement };
}

export function parseDecideAppealRequest(body: unknown): DecideModerationAppealRequest {
  const input = asRecord(body);
  const errors: FieldError[] = [];
  if (input.decision !== 'upheld' && input.decision !== 'denied') {
    errors.push({ field: 'decision', message: 'must be one of upheld, denied' });
  }
  const reason = requiredText(input.reason, 'reason', MAX_REASON_LENGTH, errors);
  if (errors.length > 0) throw validationError(errors);
  return { decision: input.decision as 'upheld' | 'denied', reason };
}

/** Path ids are shape-checked before they reach a `uuid` column (else Postgres `22P02` → opaque 500). */
export function isModerationId(value: string): boolean {
  return isUuid(value);
}
