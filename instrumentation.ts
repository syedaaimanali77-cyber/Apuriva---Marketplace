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
}
