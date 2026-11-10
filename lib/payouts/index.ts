/**
 * Spec 024 — the payouts & earnings domain barrel, and its composition-root registration.
 *
 * `registerPayoutIntegration()` is called from `instrumentation.ts` (and by each test file, because
 * Vitest gives every file its own module registry). It registers this spec's `RefundReconciliationSink`
 * with spec 022's port, so a completed refund is reconciled promptly. The durable
 * `refunds.reconciliation_state` column remains the source of truth: the payout sweep's pull pass
 * picks up anything the sink missed.
 *
 * Dependency direction is strictly spec 024 → specs 005/008/009/021/022. Spec 022 never imports this.
 */
import { registerRefundReconciliationSink } from '@/lib/refunds/reconciliation';
import { reconcileRefund } from './ledger';

let registered = false;

export function registerPayoutIntegration(): void {
  if (registered) return;
  registered = true;
  registerRefundReconciliationSink(async (event) => {
    // Only the id is used: every figure is re-read under lock, never trusted from the payload.
    await reconcileRefund(event.refundId);
  });
}

/** Test-only: allows a suite to re-register after spec 022's reset restored its default sink. */
export function resetPayoutIntegrationRegistration(): void {
  registered = false;
}

export {
  executeEarningsAdjustment,
  executePayoutRetry,
  initiateEarningsAdjustment,
  initiatePayoutRetry,
  PAYOUTS_ADJUST_ACTION,
  PAYOUTS_READ_ACTION,
  PAYOUTS_RESOURCE,
  PAYOUTS_RETRY_ACTION,
  requirePayoutPermission,
  requirePayoutPermissionOrNotFound,
} from './admin';
export { computeLineFigures, feeOn, PlatformFeeUnconfigured, resolvePlatformFeeBps } from './fees';
export { evaluateEligibility, type EligibilityFacts } from './eligibility';
export { closeBatch, reconcileRefund } from './ledger';
export {
  createPayoutMethod,
  listPayoutMethods,
  removePayoutMethod,
  setDefaultPayoutMethod,
} from './payout-methods';
export {
  emitPayoutNotification,
  getPayoutHoldGate,
  registerPayoutHoldGate,
  registerPayoutNotificationSink,
  resetPayoutHoldGate,
  resetPayoutNotificationSink,
  type PayoutHoldGate,
  type PayoutNotificationEvent,
  type PayoutNotificationSink,
} from './ports';
export {
  availableCurrencies,
  earningsSummary,
  listAdminAdjustments,
  listAdminPayouts,
  listEarningsLines,
  listProviderPayouts,
  loadAdminPayoutDetail,
  loadProviderPayoutDetail,
  parseCurrency,
  resolveDateRange,
} from './read';
export { buildStatement } from './statement';
export { isAllowedPayoutTransition, PAYOUT_TRANSITIONS } from './state-machine';
export { runPayoutReconcileSweep, runPayoutSweep, type PayoutReconcileResult, type PayoutSweepResult } from './sweep';
