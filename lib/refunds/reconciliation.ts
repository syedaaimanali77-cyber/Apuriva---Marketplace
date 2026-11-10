/**
 * Spec 022 §3 "Reconciliation seam" (AC-4) — spec 024 owns the ledger; this spec produces the fact.
 *
 * What spec 022 guarantees:
 *   - a refund that the provider confirmed is durably `completed` with
 *     `reconciliation_state = 'pending'`;
 *   - spec 022 NEVER writes `reconciled` — that column is spec 024's only write into this table,
 *     and `no-policy-leak.test.ts` asserts it at source level;
 *   - `refunds_reconciliation_idx` on `(reconciliation_state, completed_at)` is the index spec 024's
 *     consumer reads.
 *
 * The DURABLE COLUMN IS THE SOURCE OF TRUTH. This sink is a latency optimisation so spec 024 can
 * react promptly when it ships; if it is inert, throws, or the process dies, the fact survives in
 * the row and spec 024 picks it up on its next pass. That is why emission is fire-and-forget AFTER
 * the transaction commits: a notification or ledger hiccup must never roll back money that has
 * already been returned to a customer.
 *
 * A delayed consumer cannot make a refund incorrect, only unreconciled — and §9 alerts on refunds
 * left `pending` beyond the reconciliation SLA rather than letting them sit silently.
 */

export interface RefundReconciliationEvent {
  refundId: string;
  bookingId: string;
  paymentId: string;
  providerProfileId: string;
  amountMinorUnits: number;
  currencyCode: string;
  completedAt: string;
}

export type RefundReconciliationSink = (event: RefundReconciliationEvent) => Promise<void>;

/** The pre-spec-024 default: no ledger exists to reduce, so there is nothing to do but record it. */
const LOG_ONLY: RefundReconciliationSink = async (event) => {
  console.log(
    JSON.stringify({
      event: 'refund.reconciliation_pending',
      refundId: event.refundId,
      bookingId: event.bookingId,
      status: 'pending',
    }),
  );
};

let currentSink: RefundReconciliationSink = LOG_ONLY;

/** Called once by spec 024 at startup to make the sink real. */
export function registerRefundReconciliationSink(sink: RefundReconciliationSink): void {
  currentSink = sink;
}

export function getRefundReconciliationSink(): RefundReconciliationSink {
  return currentSink;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetRefundReconciliationSink(): void {
  currentSink = LOG_ONLY;
}

/**
 * Emits the reconciliation fact without ever letting the emission fail the refund.
 *
 * Called only after the completing transaction has committed. A throwing sink is logged and
 * swallowed: the refund is already financially complete because the PROVIDER confirmed it, and
 * nothing downstream may retroactively call that into question.
 */
export async function emitRefundReconciliation(event: RefundReconciliationEvent): Promise<void> {
  try {
    await getRefundReconciliationSink()(event);
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'refund.reconciliation_sink_failed', refundId: event.refundId, error: String(err) }),
    );
  }
}
