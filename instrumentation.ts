/**
 * Next.js composition root — `register()` runs exactly once per server instance, before the server
 * handles any request (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`).
 *
 * Spec 021 §3 "Booking boundary" needs one: its booking-confirmation gate has to be live for
 * `POST /api/v1/bookings`, but that route is a SPEC 020 file and may not import a payment module —
 * `lib/bookings/payment-boundary.test.ts` asserts exactly that. Wiring the two specs together here,
 * outside both, is what keeps the dependency one-directional in production as well as in tests.
 *
 * The wiring itself lives in `lib/server-integrations.ts`, which the API and cron route wrappers also call: in
 * the production build, registrations made only here never reached the route handlers.
 */
export async function register(): Promise<void> {
  // Node only. Next compiles this file for BOTH runtimes, but every registration below wires Node
  // server modules (pg, node:crypto, …) and APURIVA has no Edge route or middleware to register
  // them for. `NEXT_RUNTIME` is inlined at build time, so the Edge build drops this whole import
  // graph instead of recompiling the entire server for Edge on every change (the documented pattern:
  // node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { ensureServerIntegrations } = await import('@/lib/server-integrations');
  await ensureServerIntegrations();
}
