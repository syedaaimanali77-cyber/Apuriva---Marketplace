import { NextResponse } from 'next/server';
import { runMessageRetentionSweep } from '@/lib/messaging';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 025 §4 "Retention and privacy" (AC-4) — Vercel Cron, scheduled `0 3 * * *` (daily) in vercel.json.
 * The same mechanism and bearer-secret check as every other cron route: no new scheduler.
 *
 * Anonymizes archived conversations past `MESSAGE_RETENTION_DAYS`; never deletes a row and never touches
 * an active conversation. Idempotent and retry-safe: the next day's run is the retry.
 */
export const GET = withCronRoute('message-retention-sweep', async () => {
  const result = await runMessageRetentionSweep();
  return NextResponse.json({ status: 'ok', ...result });
});
