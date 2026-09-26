import { NextRequest, NextResponse } from 'next/server';
import { runFraudSignalSweep } from '@/lib/moderation';

export const dynamic = 'force-dynamic';

/**
 * Spec 038 §3.6 C1 — Vercel Cron, the same mechanism and bearer-secret check as every other
 * `/cron/*` route. Scheduled hourly in vercel.json. Excluded from the OpenAPI contract by
 * `scripts/check-openapi-drift.ts`, like every cron route.
 *
 * It evaluates the ACTIVE rules (those whose env thresholds are configured) and creates review items.
 * It restricts, suspends and bans no one: only a human admin, and for a ban a second admin, can.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runFraudSignalSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
