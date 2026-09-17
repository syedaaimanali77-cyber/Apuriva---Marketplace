import { NextRequest, NextResponse } from 'next/server';
import { dispatchAvailabilityNotifications } from '@/lib/availability/notify-dispatch';
import { runNotificationDispatchSweep } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

/**
 * Spec 026 §9 "Cron" (AC-6, AC-10) — Vercel Cron, scheduled `*\/5 * * * *` in vercel.json. The same
 * mechanism and bearer-secret check as every other cron route: no worker, no new scheduler. Not a
 * browser route — no session, no CSRF, no rate limit, and not in OpenAPI.
 *
 * 1. Spec 016's pending availability opt-ins whose provider is now available become notifications.
 * 2. Due outbound deliveries are attempted, retried, fallen back and escalated.
 * A production deployment with only a sandbox adapter answers `503` and marks nothing delivered.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const availability = await dispatchAvailabilityNotifications();
  const result = await runNotificationDispatchSweep();
  return NextResponse.json(
    {
      status: result.providerUnavailable ? 'provider_unavailable' : 'ok',
      availabilityNotificationsSent: availability.sent,
      ...result,
    },
    { status: result.providerUnavailable ? 503 : 200 },
  );
}
