/**
 * Spec 032 — the ticket id from the URL path, and the admin-conflict guard every admin route needs.
 *
 * The id is read from the path rather than from a Next.js `params` promise for the same reason
 * spec 029's `reviewIdFromUrl`, spec 030's `safetyReportIdFromUrl` and spec 031's
 * `disputeIdFromUrl` do: these handlers are driven directly in integration tests with a plain
 * `Request`, and a helper that works identically in both places keeps the routes thin.
 */
import { isRequesterOfTicket } from '@/lib/support';
import { supportParticipantConflictError } from '@/lib/support/errors';

export function supportTicketIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}

/**
 * DECIDED-9 — an admin may not act on a ticket they raised themselves.
 *
 * Checked BEFORE the permission check on every admin route, so the refusal names the real reason
 * rather than a permission the admin does in fact hold. They keep full access *as the requester*
 * through the participant routes, which is the access they are actually entitled to.
 */
export async function assertNotOwnTicket(ticketId: string, adminUserId: string): Promise<void> {
  if (await isRequesterOfTicket(ticketId, adminUserId)) throw supportParticipantConflictError();
}
