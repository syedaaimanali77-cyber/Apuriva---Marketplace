/**
 * Spec 023 §3 "Evidence model and the location signal" (AC-5, AC-10).
 *
 * WHAT THIS DELIBERATELY IS NOT: a location-tracking system. This repository captures no device
 * location anywhere — spec 020 states that no GPS or geofence can move the booking state machine,
 * and `lib/bookings/**` imports no location module. Building a location-evidence pipeline would mean
 * creating surveillance infrastructure that does not exist, which master spec §51's "location
 * signals where appropriate" plainly does not require.
 *
 * So: nothing is collected. Every signal below is DERIVED from data the platform already holds for
 * another purpose, and the only location datum is a single three-valued enum computed from spec
 * 012's existing service-area primitive over an address the customer already saved and a service
 * area the provider already declared. No coordinate is ever written to `no_show_reports` — the table
 * has no column that could hold one — and no route returns one.
 *
 * `'unavailable'` is a first-class value, not a degraded one. `resolution.ts` takes no location
 * argument at all, so a fault finding CANNOT rest on this signal even in principle (AC-5).
 */
import { sql } from 'drizzle-orm';
import { isProviderEligibleForLocation, listServiceAreas } from '@/lib/availability/service-areas';
import { fromMicroDegrees } from '@/lib/location/geo';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { NoShowEvidence, NoShowLocationSignal } from '@/lib/types/no-show';

/**
 * Spec 025 owns messaging, which has not shipped. Rather than fake a message store, this ships the
 * port: the default reports `{ available: false }`, and spec 025 registers a real reader that must
 * return a COUNT AND LAST INSTANT ONLY — never message bodies, which are not this spec's to expose
 * to an admin (AC-10).
 */
export type NoShowCommunicationsEvidence = (
  tx: Executor,
  bookingId: string,
) => Promise<{ available: boolean; messageCount?: number; lastMessageAt?: string }>;

const NO_COMMUNICATIONS: NoShowCommunicationsEvidence = async () => ({ available: false });

let communicationsReader: NoShowCommunicationsEvidence = NO_COMMUNICATIONS;

export function registerNoShowCommunicationsEvidence(reader: NoShowCommunicationsEvidence): void {
  communicationsReader = reader;
}

export function resetNoShowCommunicationsEvidence(): void {
  communicationsReader = NO_COMMUNICATIONS;
}

/**
 * The coarse, derived location signal.
 *
 * Reuses spec 016's `isProviderEligibleForLocation` — the SAME primitive matching already uses —
 * rather than re-reading `provider_service_areas` here: a second implementation of "is this address
 * in this provider's area" could drift from the one that decides eligibility, and an admin reviewing
 * a report must see the platform's own answer, not this spec's opinion of it.
 *
 * `listServiceAreas` first, because spec 016 treats "no declared area" as UNRESTRICTED (`true`),
 * which would read as evidence when it is really the absence of evidence. A provider who declared
 * nothing yields `'unavailable'`, as does an address without coordinates or a `remote` area.
 */
export async function deriveLocationSignal(_tx: Executor, bookingId: string): Promise<NoShowLocationSignal> {
  const [row] = await queryRows<{
    provider_profile_id: string;
    service_id: string;
    latitude_micro_degrees: number | null;
    longitude_micro_degrees: number | null;
    structured: { city?: string } | null;
  }>(
    _tx,
    sql`SELECT b.provider_profile_id, b.service_id,
               l.latitude_micro_degrees, l.longitude_micro_degrees, a.structured
          FROM bookings b
          JOIN addresses a ON a.id = b.address_id
          JOIN locations l ON l.id = a.location_id
         WHERE b.id = ${bookingId}`,
  );
  if (!row) return 'unavailable';

  const declared = await listServiceAreas(row.provider_profile_id);
  const applicable =
    declared.find((area) => area.serviceId === row.service_id) ?? declared.find((area) => area.serviceId === null);
  // Nothing declared, or a remote area: there is no geographic claim to compare against.
  if (!applicable || applicable.mode === 'remote') return 'unavailable';

  const hasPoint = row.latitude_micro_degrees !== null && row.longitude_micro_degrees !== null;
  if (applicable.mode === 'radius' && !hasPoint) return 'unavailable';
  if (applicable.mode === 'cities' && !row.structured?.city) return 'unavailable';

  const within = await isProviderEligibleForLocation(row.provider_profile_id, row.service_id, {
    point: hasPoint
      ? {
          latitude: fromMicroDegrees(row.latitude_micro_degrees!),
          longitude: fromMicroDegrees(row.longitude_micro_degrees!),
        }
      : undefined,
    city: row.structured?.city,
  });
  return within ? 'address_within_service_area' : 'address_outside_service_area';
}

/**
 * The evidence bundle — booking timing, the booking's own status history, the attendance instants
 * derived from it, and whether communications exist.
 *
 * Every field is a status, a role or an instant. There is no free text, no message body, no
 * coordinate and no inference: the admin is shown facts and draws their own conclusion, which is the
 * whole of master spec §51's "do not automatically accuse".
 */
export async function gatherEvidence(tx: Executor, bookingId: string): Promise<NoShowEvidence> {
  const [booking] = await queryRows<{ scheduled_at: Date; minutes_after: string | number }>(
    tx,
    sql`SELECT scheduled_at,
               EXTRACT(EPOCH FROM (clock_timestamp() - scheduled_at)) / 60 AS minutes_after
          FROM bookings WHERE id = ${bookingId}`,
  );
  if (!booking) throw new Error(`booking ${bookingId} not found while gathering no-show evidence`);

  const history = await queryRows<{
    to_status: string;
    actor_role: 'customer' | 'provider' | 'system';
    occurred_at: Date;
  }>(
    tx,
    sql`SELECT to_status, actor_role, occurred_at FROM bookings_status_history
         WHERE booking_id = ${bookingId} ORDER BY occurred_at`,
  );

  const firstInstant = (status: string): string | null => {
    const row = history.find((entry) => entry.to_status === status);
    return row ? new Date(row.occurred_at).toISOString() : null;
  };

  return {
    scheduledAt: new Date(booking.scheduled_at).toISOString(),
    minutesAfterScheduled: Math.round(Number(booking.minutes_after)),
    reachedProviderEnRouteAt: firstInstant('provider_en_route'),
    reachedArrivedAt: firstInstant('arrived'),
    reachedInProgressAt: firstInstant('in_progress'),
    statusHistory: history.map((entry) => ({
      toStatus: entry.to_status,
      actorRole: entry.actor_role,
      occurredAt: new Date(entry.occurred_at).toISOString(),
    })),
    communications: await communicationsReader(tx, bookingId),
  };
}
