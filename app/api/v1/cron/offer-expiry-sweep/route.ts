import { NextRequest, NextResponse } from 'next/server';
import { runOfferExpirySweep } from '@/lib/offers/expiry';

export const dynamic = 'force-dynamic';

/**
 * Spec 018 §3 "Background expiry" (AC-3) — Vercel Cron (spec 001 §8 risk #1, the same mechanism and
 * bearer-secret check as app/api/v1/cron/data-export-sweep), scheduled `* * * * *` in vercel.json.
 * Persists `expired` on offers past `expires_at` with no client involved. Idempotent and retry-safe:
 * the next minute's run is the retry.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const { expired } = await runOfferExpirySweep();
  return NextResponse.json({ status: 'ok', expired });
}
