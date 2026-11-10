import { NextResponse } from 'next/server';
import { sweepAnalyticsRetention } from '@/lib/analytics/retention';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 040 §4 "Retention and privacy" — Vercel Cron (daily, vercel.json), the same bearer-secret
 * idiom as every other cron route (spec 001 §8: no worker, no queue). Not a browser route and not in
 * OpenAPI. Deletes events past `ANALYTICS_EVENT_RETENTION_DAYS` and de-attributes events of deleted
 * accounts, batched — the next run continues.
 */
export const GET = withCronRoute('analytics-retention-sweep', async () => {
  const { deleted, deattributed } = await sweepAnalyticsRetention();
  return NextResponse.json({ status: 'ok', eventsDeleted: deleted, eventsDeattributed: deattributed });
});
