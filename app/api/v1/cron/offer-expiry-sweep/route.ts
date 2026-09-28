import { NextResponse } from 'next/server';
import { runOfferExpirySweep } from '@/lib/offers/expiry';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 018 §3 "Background expiry" (AC-3) — Vercel Cron (spec 001 §8 risk #1, the same mechanism and
 * bearer-secret check as app/api/v1/cron/data-export-sweep), scheduled `* * * * *` in vercel.json.
 * Persists `expired` on offers past `expires_at` with no client involved. Idempotent and retry-safe:
 * the next minute's run is the retry.
 */
export const GET = withCronRoute('offer-expiry-sweep', async () => {
  const { expired } = await runOfferExpirySweep();
  return NextResponse.json({ status: 'ok', expired });
});
