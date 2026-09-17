import { NextRequest, NextResponse } from 'next/server';
import { runMessageRetentionSweep } from '@/lib/messaging';

export const dynamic = 'force-dynamic';

/**
 * Spec 025 §4 "Retention and privacy" (AC-4) — Vercel Cron, scheduled `0 3 * * *` (daily) in vercel.json.
 * The same mechanism and bearer-secret check as every other cron route: no new scheduler.
 *
 * Anonymizes archived conversations past `MESSAGE_RETENTION_DAYS`; never deletes a row and never touches
 * an active conversation. Idempotent and retry-safe: the next day's run is the retry.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runMessageRetentionSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
