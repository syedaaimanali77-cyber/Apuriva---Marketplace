/**
 * Spec 036 §3 contract 1 — the DISPLAY rows of a confirmation card: master spec §90's parameters
 * (Service, Provider, Date/time, Price — Price carrying its currency) WITHOUT Location, which is
 * address text and too sensitive to store in spec 035's confirmation record (review decision).
 *
 * Every value is derived server-side from LIVE domain data, never from model output. The rows are
 * recomputed when the confirmation is resolved and again at execution, so a change in any of them —
 * a revised price, a moved slot — is a stale binding under spec 035's `bindingMatches` (AC-3).
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerProfiles, services } from '@/lib/db/schema';
import type { McpBoundParameter } from '@/lib/mcp';
import { formatMinorUnits } from '@/lib/notifications/sinks';

export const DISPLAY_LABELS = ['Service', 'Provider', 'Date/time', 'Price'] as const;

/** The instant as a person reads it, in the IANA zone it is local to (spec 003 AC-2). */
export function formatInstant(instant: string, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));
  return `${formatted} (${timeZone})`;
}

export async function serviceNameOf(serviceId: string): Promise<string | null> {
  const [row] = await getDb().select({ name: services.name }).from(services).where(eq(services.id, serviceId));
  return row?.name ?? null;
}

export async function providerNameOf(providerProfileId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ name: providerProfiles.businessName })
    .from(providerProfiles)
    .where(eq(providerProfiles.id, providerProfileId));
  return row?.name ?? null;
}

/** Builds the rows in §90 order, leaving out any value the domain does not hold (never invented). */
export function displayRows(values: {
  service: string | null;
  provider: string | null;
  when: { instant: string; timeZone: string } | null;
  price: { amountMinorUnits: number; currencyCode: string };
}): McpBoundParameter[] {
  const rows: McpBoundParameter[] = [];
  if (values.service) rows.push({ label: 'Service', value: values.service });
  if (values.provider) rows.push({ label: 'Provider', value: values.provider });
  if (values.when) rows.push({ label: 'Date/time', value: formatInstant(values.when.instant, values.when.timeZone) });
  rows.push({ label: 'Price', value: formatMinorUnits(values.price.amountMinorUnits, values.price.currencyCode) });
  return rows;
}
