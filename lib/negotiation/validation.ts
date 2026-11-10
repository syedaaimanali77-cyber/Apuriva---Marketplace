/**
 * Spec 019 §3 body validation for messages and change requests. Pure — no I/O. Lengths are measured on the
 * trimmed INPUT, before contact redaction. Revision bodies reuse spec 018's `validateOfferTerms`.
 */
import { validationError } from '@/lib/api/errors';
import { MAX_PRICE_MINOR_UNITS } from '@/lib/offers/validation';
import { CHANGE_REQUEST_NOTE_MAX_LENGTH, MESSAGE_BODY_MAX_LENGTH } from './limits';

function asObject(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function validateMessageBody(raw: unknown): string {
  const body = asObject(raw).body;
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (typeof body !== 'string' || trimmed.length === 0 || trimmed.length > MESSAGE_BODY_MAX_LENGTH) {
    throw validationError([{ field: 'body', message: `must be 1-${MESSAGE_BODY_MAX_LENGTH} characters` }]);
  }
  return trimmed;
}

export interface ValidatedChangeRequest {
  note: string;
  proposedPriceAmountMinorUnits: number | null;
}

export function validateChangeRequestBody(raw: unknown): ValidatedChangeRequest {
  const body = asObject(raw);
  const errors: { field: string; message: string }[] = [];

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (typeof body.note !== 'string' || note.length === 0 || note.length > CHANGE_REQUEST_NOTE_MAX_LENGTH) {
    errors.push({ field: 'note', message: `must be 1-${CHANGE_REQUEST_NOTE_MAX_LENGTH} characters` });
  }

  let proposedPriceAmountMinorUnits: number | null = null;
  const price = body.proposedPriceAmountMinorUnits;
  if (price !== undefined && price !== null) {
    if (!Number.isInteger(price) || (price as number) <= 0 || (price as number) > MAX_PRICE_MINOR_UNITS) {
      errors.push({
        field: 'proposedPriceAmountMinorUnits',
        message: `must be a positive integer no greater than ${MAX_PRICE_MINOR_UNITS}`,
      });
    } else {
      proposedPriceAmountMinorUnits = price as number;
    }
  }

  if (errors.length > 0) throw validationError(errors);
  return { note, proposedPriceAmountMinorUnits };
}
