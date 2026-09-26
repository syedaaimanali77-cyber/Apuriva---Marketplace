import { apiSuccess } from '@/lib/api/response';
import { getDb } from '@/lib/db';
import { ANALYTICS_ACTIONS } from '@/lib/analytics/access';
import { matchingFairnessReport } from '@/lib/analytics/reports';
import { analyticsReportRoute } from '@/lib/analytics/route';

/** Spec 040 §3.5 R5 matching fairness (AC-4) — spec 017 AC-3's exploration exposure, computed. Aggregates only (AC-3). */
export const GET = analyticsReportRoute(ANALYTICS_ACTIONS.readProviderPerformance, async (range, _params, correlationId) =>
  apiSuccess(await matchingFairnessReport(getDb(), range), correlationId),
);
