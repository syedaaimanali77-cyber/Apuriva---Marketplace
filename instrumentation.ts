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
}
