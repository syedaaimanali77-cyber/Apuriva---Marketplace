import { NextRequest, NextResponse } from 'next/server';
import { sweepAnalyticsRetention } from '@/lib/analytics/retention';

export const dynamic = 'force-dynamic';

/**
 * Spec 040 §4 "Retention and privacy" — Vercel Cron (daily, vercel.json), the same bearer-secret
 * idiom as every other cron route (spec 001 §8: no worker, no queue). Not a browser route and not in
 * OpenAPI. Deletes events past `ANALYTICS_EVENT_RETENTION_DAYS` and de-attributes events of deleted
 * accounts, batched — the next run continues.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }
  const { deleted, deattributed } = await sweepAnalyticsRetention();
  return NextResponse.json({ status: 'ok', eventsDeleted: deleted, eventsDeattributed: deattributed });
}
