import { NextRequest, NextResponse } from 'next/server';
import { evaluateAiAbuseSignals, evaluateAiCostAlerts, sweepAiUsageRetention } from '@/lib/ai';

export const dynamic = 'force-dynamic';

/**
 * Spec 033 §3.2 — scheduled job (Vercel Cron, same mechanism/pattern as
 * app/api/v1/cron/account-deletion-sweep). Hourly, server-side, idempotent and retry-safe, and
 * never dependent on client execution. Three passes, in this order:
 *
 *   1. retention — delete `ai_usage_events` past `AI_USAGE_RETENTION_DAYS` (batched);
 *   2. abuse — evaluate the four deterministic signals, writing at most one `ai.abuse_signal`
 *      per subject/signal/UTC day. It flags for HUMAN review and enforces nothing;
 *   3. cost — evaluate the day/month thresholds, at most one `ai.cost_alert` per scope per period.
 *
 * Retention runs first so neither evaluation reads rows that are already past their window. A pass
 * that throws is reported rather than masked; the next hourly run is the retry.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const { deleted } = await sweepAiUsageRetention();
  const abuse = await evaluateAiAbuseSignals();
  const { emitted } = await evaluateAiCostAlerts();

  return NextResponse.json({
    status: 'ok',
    usageRowsDeleted: deleted,
    subjectsEvaluated: abuse.evaluated,
    abuseSignalsFlagged: abuse.flagged,
    costAlertsEmitted: emitted,
  });
}
