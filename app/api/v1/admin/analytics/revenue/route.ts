import { apiSuccess } from '@/lib/api/response';
import { getDb } from '@/lib/db';
import { ANALYTICS_ACTIONS } from '@/lib/analytics/access';
import { revenueReport } from '@/lib/analytics/reports';
import { analyticsReportRoute } from '@/lib/analytics/route';

/** Spec 040 §3.5 R2 revenue — per currency, never summed across currencies. Aggregates only (AC-3). */
export const GET = analyticsReportRoute(ANALYTICS_ACTIONS.readRevenue, async (range, _params, correlationId) =>
  apiSuccess(await revenueReport(getDb(), range), correlationId),
);
