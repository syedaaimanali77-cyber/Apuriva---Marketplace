import { apiSuccess } from '@/lib/api/response';
import { getDb } from '@/lib/db';
import { ANALYTICS_ACTIONS } from '@/lib/analytics/access';
import { funnelReport } from '@/lib/analytics/reports';
import { analyticsReportRoute } from '@/lib/analytics/route';

/** Spec 040 §3.5 R1 funnel — period counts per stage (discover → request → offer → booking → complete). Aggregates only (AC-3). */
export const GET = analyticsReportRoute(ANALYTICS_ACTIONS.read, async (range, _params, correlationId) =>
  apiSuccess(await funnelReport(getDb(), range), correlationId),
);
