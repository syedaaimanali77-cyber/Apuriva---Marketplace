/**
 * Spec 031 — the dispute id from the URL path, and the participant/admin routing every shared
 * route needs.
 *
 * The id is read from the path rather than from a Next.js `params` promise for the same reason
 * spec 029's `reviewIdFromUrl` and spec 030's `safetyReportIdFromUrl` do: these handlers are driven
 * directly in integration tests with a plain `Request`, and a helper that works identically in both
 * places keeps the routes thin.
 */
import { getDb } from '@/lib/db';
import { isDisputeParticipant, loadDisputeOwnership } from '@/lib/disputes';
import { disputeNotFoundError } from '@/lib/disputes/errors';

export function disputeIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}

/**
 * Decides whether this caller should be served by the participant path or the admin path.
 *
 * The participant check comes FIRST and is decisive. An admin who is also a party to the booking is
 * therefore routed to the participant view, which is exactly right: they see it as the participant
 * they are, and `resolveAdminAccess` would refuse them `DISPUTE_PARTICIPANT_CONFLICT` anyway.
 *
 * Everyone else — including an authenticated user with no relationship to the dispute and no
 * permission — falls through to the admin path, where `requireDisputeReadPermission` answers `403`
 * and `resolveAdminAccess` answers `404` for a dispute that does not exist. Neither reveals the
 * dispute's existence to someone who should not know about it.
 */
export async function isParticipantOf(disputeId: string, userId: string): Promise<boolean> {
  const ownership = await loadDisputeOwnership(disputeId, getDb());
  if (!ownership) throw disputeNotFoundError();
  return isDisputeParticipant(ownership, userId);
}
