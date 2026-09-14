/**
 * Spec 018 §3 offer-creation body validation (rule 2). Pure — no I/O — so every bound is unit-tested.
 *
 * Client-supplied `sentAt`, `expiresAt`, `status` or any duration-of-window field is never read:
 * only the fields below are extracted, so anything else in the body has no effect (AC-7).
 */
import { validationError } from '@/lib/api/errors';
import type { CreateOfferRequest } from '@/lib/types/offers';

export const MAX_PRICE_MINOR_UNITS = 2_147_483_647;
export const MAX_INCLUDED_ITEMS = 20;
export const MAX_INCLUDED_ITEM_LENGTH = 200;
export const MAX_PROVIDER_MESSAGE_LENGTH = 1000;
export const MIN_ESTIMATED_DURATION_MINUTES = 1;
export const MAX_ESTIMATED_DURATION_MINUTES = 1440;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export interface ValidatedOfferInput {
  requestId: string;
  priceAmountMinorUnits: number;
  currencyCode: string;
  includedItems: string[];
  providerMessage: string | null;
  estimatedDurationMinutes: number | null;
}

export function validateCreateOfferBody(raw: unknown): ValidatedOfferInput {
  const body = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Partial<
    Record<keyof CreateOfferRequest, unknown>
  >;
  const errors: { field: string; message: string }[] = [];

  if (!isUuid(body.requestId)) errors.push({ field: 'requestId', message: 'must be a valid request id' });

  const price = body.priceAmountMinorUnits;
  if (!Number.isInteger(price) || (price as number) <= 0 || (price as number) > MAX_PRICE_MINOR_UNITS) {
    errors.push({ field: 'priceAmountMinorUnits', message: `must be a positive integer no greater than ${MAX_PRICE_MINOR_UNITS}` });
  }

  if (typeof body.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(body.currencyCode)) {
    errors.push({ field: 'currencyCode', message: 'must be a 3-letter uppercase ISO 4217 code' });
  }

  let includedItems: string[] = [];
  if (body.includedItems !== undefined && body.includedItems !== null) {
    if (!Array.isArray(body.includedItems)) {
      errors.push({ field: 'includedItems', message: 'must be an array of strings' });
    } else if (body.includedItems.length > MAX_INCLUDED_ITEMS) {
      errors.push({ field: 'includedItems', message: `must contain at most ${MAX_INCLUDED_ITEMS} items` });
    } else {
      includedItems = body.includedItems.map((item) => (typeof item === 'string' ? item.trim() : ''));
      body.includedItems.forEach((item, index) => {
        const trimmed = typeof item === 'string' ? item.trim() : '';
        if (typeof item !== 'string' || trimmed.length === 0 || trimmed.length > MAX_INCLUDED_ITEM_LENGTH) {
          errors.push({ field: `includedItems[${index}]`, message: `must be 1-${MAX_INCLUDED_ITEM_LENGTH} characters` });
        }
      });
    }
  }

  let providerMessage: string | null = null;
  if (body.providerMessage !== undefined && body.providerMessage !== null) {
    if (typeof body.providerMessage !== 'string') {
      errors.push({ field: 'providerMessage', message: 'must be a string' });
    } else {
      const trimmed = body.providerMessage.trim();
      if (trimmed.length > MAX_PROVIDER_MESSAGE_LENGTH) {
        errors.push({ field: 'providerMessage', message: `must be at most ${MAX_PROVIDER_MESSAGE_LENGTH} characters` });
      }
      providerMessage = trimmed.length === 0 ? null : trimmed;
    }
  }

  let estimatedDurationMinutes: number | null = null;
  if (body.estimatedDurationMinutes !== undefined && body.estimatedDurationMinutes !== null) {
    const d = body.estimatedDurationMinutes;
    if (!Number.isInteger(d) || (d as number) < MIN_ESTIMATED_DURATION_MINUTES || (d as number) > MAX_ESTIMATED_DURATION_MINUTES) {
      errors.push({
        field: 'estimatedDurationMinutes',
        message: `must be an integer from ${MIN_ESTIMATED_DURATION_MINUTES} to ${MAX_ESTIMATED_DURATION_MINUTES}`,
      });
    } else {
      estimatedDurationMinutes = d as number;
    }
  }

  if (errors.length > 0) throw validationError(errors);

  return {
    requestId: body.requestId as string,
    priceAmountMinorUnits: price as number,
    currencyCode: body.currencyCode as string,
    includedItems,
    providerMessage,
    estimatedDurationMinutes,
  };
}
