import { apiSuccess } from '@/lib/api/response';
import { getDb } from '@/lib/db';
import { ANALYTICS_ACTIONS } from '@/lib/analytics/access';
import { supplyDemandReport } from '@/lib/analytics/reports';
import { analyticsReportRoute } from '@/lib/analytics/route';

/** Spec 040 §3.5 R3 supply/demand — requests in the window vs active providers, per service. Aggregates only (AC-3). */
export const GET = analyticsReportRoute(ANALYTICS_ACTIONS.read, async (range, _params, correlationId) =>
  apiSuccess(await supplyDemandReport(getDb(), range), correlationId),
);
