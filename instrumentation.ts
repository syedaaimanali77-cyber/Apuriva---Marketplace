/**
 * Next.js composition root — `register()` runs exactly once per server instance, before the server
 * handles any request (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`).
 *
 * Spec 021 §3 "Booking boundary" needs one: its booking-confirmation gate has to be live for
 * `POST /api/v1/bookings`, but that route is a SPEC 020 file and may not import a payment module —
 * `lib/bookings/payment-boundary.test.ts` asserts exactly that. Wiring the two specs together here,
 * outside both, is what keeps the dependency one-directional in production as well as in tests.
 */
export async function register(): Promise<void> {
  const { registerPaymentIntegration } = await import('@/lib/payments');
  registerPaymentIntegration();

  // Spec 022 registers the three payment transitions and four booking transitions it owns.
  const { registerRefundIntegration } = await import('@/lib/refunds');
  registerRefundIntegration();

  // Spec 023 registers the three `-> cancelled` booking transitions spec 020 reserved for it, and
  // replaces spec 022's inert refund-eligibility default with the real cancellation-policy decision.
  const { registerCancellationIntegration } = await import('@/lib/cancellation');
  registerCancellationIntegration();

  // Spec 024 registers its refund reconciliation sink with spec 022's port. The durable
  // `refunds.reconciliation_state` column stays the source of truth; the payout sweep pulls anything missed.
  const { registerPayoutIntegration } = await import('@/lib/payouts');
  registerPayoutIntegration();

  // Spec 026 registers its sinks with the notification ports specs 022, 023, 024 and 025 shipped inert.
  // Rolling spec 026 back returns each port to its log-only default — no producing spec breaks.
  const { registerNotificationIntegration } = await import('@/lib/notifications');
  registerNotificationIntegration();

  // Spec 027 implements the `FileAssetStorage` port spec 008 has always depended on (AC-10) and
  // registers the three shipped file context policies (AC-8). Spec 008's code is not touched;
  // rolling spec 027 back returns its port to throwing, which is that port's documented pre-027
  // behaviour, so no shipped spec breaks.
  const { registerFileIntegration } = await import('@/lib/files');
  registerFileIntegration();

  // Spec 028 makes two ports real that shipped inert on purpose: spec 020's `CompletionEvidenceGate`
  // (default: nothing requires evidence) and spec 027's `booking_evidence` context (default: `422
  // FILE_CONTEXT_NOT_AVAILABLE`). It must run AFTER spec 027, which resets and registers its own
  // shipped policies. Rolling spec 028 back returns both ports to those documented defaults, so no
  // shipped spec breaks.
  const { registerServiceExecutionIntegration } = await import('@/lib/bookings');
  registerServiceExecutionIntegration();

  // Spec 029 makes two more ports real that shipped inert on purpose: spec 027's `review_media`
  // context (default: `422 FILE_CONTEXT_NOT_AVAILABLE`) and spec 017's `ProviderRatingSource`
  // (default: `null` for every provider, i.e. the `rating` factor excluded from scoring — which is
  // spec 017's behaviour today). It must run AFTER spec 027, which resets and registers its own
  // shipped policies. Rolling spec 029 back returns both ports to those documented defaults, so no
  // shipped spec breaks.
  const { registerReviewsIntegration } = await import('@/lib/reviews');
  registerReviewsIntegration();

  // Spec 030 makes three more ports real that shipped inert on purpose: spec 025's
  // `ConversationBlockGate` (default: nobody blocked), spec 017's `ProviderBlockSource` (default:
  // nobody blocked) and spec 027's `safety_evidence` context (default:
  // `422 FILE_CONTEXT_NOT_AVAILABLE`). It must run AFTER spec 027, which resets and registers its
  // own shipped policies, and after spec 029, which registers its own context.
  //
  // IT DELIBERATELY DOES NOT REGISTER `SafetyRestrictionGate`. Spec 030 owns no enforcement action;
  // that registration is SPEC 038's, from this same root, when it ships. Until then the port's
  // refusing default is what tells an admin the capability is not installed (spec 030 DECIDED-3).
  const { registerSafetyIntegration } = await import('@/lib/safety');
  registerSafetyIntegration();

  // Spec 031 registers the two booking transitions spec 020 reserved for it
  // (`protected -> disputed`, `disputed -> protected`), makes spec 021's `DisputeGate` real
  // (default: no booking is ever disputed — its own comment says "Spec 031 registers the real gate
  // when it ships"), and registers spec 027's `dispute_evidence` context (default:
  // `422 FILE_CONTEXT_NOT_AVAILABLE`). It must run AFTER spec 027, which resets and registers its
  // own shipped policies, and after specs 029/030, which register theirs.
  //
  // IT DELIBERATELY DOES NOT REGISTER spec 024's `PayoutHoldGate` (that slot is spec 038's) or
  // spec 022's `RefundEligibilityGate` (already occupied by spec 023, and single-valued). A dispute
  // holds a payout through spec 021's protection state, which spec 024 already refuses to pay out
  // from, and reaches a refund only through spec 022's admin-override route.
  //
  // Rolling spec 031 back returns the gate to its inert default — the sweep resumes releasing and
  // no shipped spec breaks.
  const { registerDisputeIntegration } = await import('@/lib/disputes');
  registerDisputeIntegration();
}
