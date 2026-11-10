import type { CancelPreviewDto, RequestStatus } from '@/lib/types/requests';
import { isCancellable } from '@/lib/types/requests';

/**
 * Spec 015 §3 "Cancellation consequence" — the ONLY place this spec encodes an opinion about a
 * cancellation's financial consequence, deliberately isolated the same way
 * `lib/privacy/booking-lifecycle-adapter.ts` isolates spec 008's provisional opinion about the
 * booking lifecycle.
 *
 * Within the states this spec can cancel (`submitted`, `matching`, `offers_open`) there is never a
 * consequence: payment authorization happens only after provider selection (spec 021), so nothing
 * has been charged and nothing can be forfeited. That is a structural fact about this spec's
 * scope, not a policy decision — spec 023's cancellation-policy engine (fees, tiers, no-show
 * consequences) is NOT implemented here and NOT duplicated here. When it ships, only this file
 * changes; `cancelRequest`/the preview route call it and never encode policy themselves.
 *
 * Master spec §38 requires the consequence be *shown before confirmation*, which is why this is
 * exposed as its own read-only dry run (`GET /requests/{id}/cancel-preview`) rather than inferred
 * by the client.
 */
export function previewCancellation(status: RequestStatus): CancelPreviewDto {
  return {
    cancellable: isCancellable(status),
    consequence: null,
    feeAmountMinorUnits: null,
    currencyCode: null,
  };
}
