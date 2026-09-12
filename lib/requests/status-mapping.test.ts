import { describe, expect, it } from 'vitest';
import { REQUEST_STATUSES } from '@/lib/db/schema';
import {
  ACTIVE_REQUEST_STATUSES,
  CANCELLABLE_REQUEST_STATUSES,
  CUSTOMER_FACING_STEP,
  customerFacingStep,
  isCancellable,
  type RequestStatus,
} from '@/lib/types/requests';
import { previewCancellation } from './cancellation-consequence';

describe('customer-facing status mapping (spec 015 AC-5)', () => {
  it('maps every internal status to a step — no status can reach the UI unmapped', () => {
    for (const status of REQUEST_STATUSES) {
      expect(customerFacingStep(status)).toBeTruthy();
    }
    expect(Object.keys(CUSTOMER_FACING_STEP).sort()).toEqual([...REQUEST_STATUSES].sort());
  });

  it('uses master spec §37 wording for the in-flight progression', () => {
    expect(customerFacingStep('submitted')).toBe('Request sent');
    expect(customerFacingStep('matching')).toBe('Providers notified');
    expect(customerFacingStep('offers_open')).toBe('Offers received');
    expect(customerFacingStep('provider_selected')).toBe('Provider selected');
    expect(customerFacingStep('booking_created')).toBe('Booking confirmed');
  });

  it('never leaks an internal matching mechanic into a customer-facing label', () => {
    const labels = Object.values(CUSTOMER_FACING_STEP).join(' ').toLowerCase();
    for (const leak of ['pool', 'rank', 'score', 'eligib', 'excluded', 'match']) {
      expect(labels).not.toContain(leak);
    }
  });
});

describe('cancellable states (spec 015 AC-4/AC-7)', () => {
  it('is exactly master spec §38\'s pre-provider-selection states', () => {
    expect(CANCELLABLE_REQUEST_STATUSES).toEqual(['submitted', 'matching', 'offers_open']);
  });

  it('is never cancellable at or after provider selection, or once terminal', () => {
    for (const status of ['draft', 'provider_selected', 'booking_created', 'cancelled', 'expired', 'completed'] as RequestStatus[]) {
      expect(isCancellable(status)).toBe(false);
    }
  });

  it('every cancellable state is also an active state', () => {
    for (const status of CANCELLABLE_REQUEST_STATUSES) {
      expect(ACTIVE_REQUEST_STATUSES).toContain(status);
    }
  });

  it('previews no consequence in every state this spec can cancel — no payment exists pre-selection', () => {
    for (const status of CANCELLABLE_REQUEST_STATUSES) {
      expect(previewCancellation(status)).toEqual({
        cancellable: true,
        consequence: null,
        feeAmountMinorUnits: null,
        currencyCode: null,
      });
    }
  });

  it('reports a non-cancellable state as not cancellable rather than throwing', () => {
    expect(previewCancellation('completed').cancellable).toBe(false);
  });
});
