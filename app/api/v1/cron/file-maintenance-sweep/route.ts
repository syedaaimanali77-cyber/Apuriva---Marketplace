import { NextResponse } from 'next/server';
import { runFileMaintenanceSweep } from '@/lib/files';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 027 §9 "Cron" (AC-4, AC-9, AC-11) — Vercel Cron, scheduled `*\/5 * * * *` in vercel.json. The
 * same mechanism and bearer-secret check as every other cron route: no worker service, no new
 * scheduler. Not a browser route — no session, no CSRF, no rate limit, and not in OpenAPI.
 *
 * Two passes: unresolved scans are retried on their backoff (so an `unknown` verdict eventually
 * resolves and a finalize whose inline attempt failed is picked up), then bytes are purged for
 * assets soft-deleted past the grace period, rejected, or never finalized. A `legal_hold` asset is
 * never purged. A production deployment with only a sandbox adapter answers `503` and purges nothing.
 */
export const GET = withCronRoute('file-maintenance-sweep', async () => {
  const result = await runFileMaintenanceSweep();
  return NextResponse.json(
    { status: result.storageUnavailable ? 'storage_unavailable' : 'ok', ...result },
    { status: result.storageUnavailable ? 503 : 200 },
  );
});
