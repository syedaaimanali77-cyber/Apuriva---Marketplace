import { NextResponse } from 'next/server';
import { runFraudSignalSweep } from '@/lib/moderation';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 038 §3.6 C1 — Vercel Cron, the same mechanism and bearer-secret check as every other
 * `/cron/*` route. Scheduled hourly in vercel.json. Excluded from the OpenAPI contract by
 * `scripts/check-openapi-drift.ts`, like every cron route.
 *
 * It evaluates the ACTIVE rules (those whose env thresholds are configured) and creates review items.
 * It restricts, suspends and bans no one: only a human admin, and for a ban a second admin, can.
 */
export const GET = withCronRoute('fraud-signal-sweep', async () => {
  const result = await runFraudSignalSweep();
  return NextResponse.json({ status: 'ok', ...result });
});
