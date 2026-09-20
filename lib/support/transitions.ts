/**
 * Spec 032 §3 "Ticket lifecycle" (AC-7, DECIDED-3) — the state machine, as DATA.
 *
 * THE TABLE IS THE AUTHORITY. Every mutating path in `lib/support/` asks `canTransition()` before
 * it writes, so there is exactly one place the lifecycle is defined and exactly one place to read
 * to know what a ticket can do. `lib/support/transitions.test.ts` asserts the table is total over
 * `SUPPORT_TICKET_STATUSES × SupportActor` and that `closed` is terminal.
 *
 * `closed` IS TERMINAL FOR EVERYONE. No row below has it as a `from`, so no actor — not the
 * requester, not a Support Admin, not `super_admin` — can leave it. A new matter is a new ticket.
 *
 * PURE: no I/O, no database.
 */
import type { SupportTicketStatus } from '@/lib/types/support';

/**
 * Who is attempting the move.
 *
 * `sweep` is the reopen-window cron. It is its own actor rather than borrowing `admin`, because it
 * may do exactly one thing — make an un-reopened resolution final — and giving it the admin's row
 * would silently grant it every admin transition.
 */
export type SupportActor = 'requester' | 'admin' | 'sweep';

export interface SupportTransition {
  from: SupportTicketStatus;
  to: SupportTicketStatus;
  actors: readonly SupportActor[];
}

export const SUPPORT_TRANSITIONS: readonly SupportTransition[] = [
  // An admin claims or is assigned the ticket.
  { from: 'open', to: 'assigned', actors: ['admin'] },
  // Reassignment. A self-loop, so the table stays the single authority for it too.
  { from: 'assigned', to: 'assigned', actors: ['admin'] },
  // The admin replies asking for information. Starts the SLA pause.
  { from: 'assigned', to: 'awaiting_user', actors: ['admin'] },
  // The requester answers — automatically, by posting any message. Ends the SLA pause. An admin
  // may also pull it back, for a user who answered out of band.
  { from: 'awaiting_user', to: 'assigned', actors: ['requester', 'admin'] },
  // Resolution is reachable from every live state: a ticket can be answered before anyone claims
  // it, and a ticket waiting on a user who never replies still has to be able to end.
  { from: 'open', to: 'resolved', actors: ['admin'] },
  { from: 'assigned', to: 'resolved', actors: ['admin'] },
  { from: 'awaiting_user', to: 'resolved', actors: ['admin'] },
  // Reopen, inside the window. The requester's is capped at one (`MAX_REQUESTER_REOPENS`); an
  // admin's does not consume it.
  { from: 'resolved', to: 'assigned', actors: ['requester', 'admin'] },
  // Closure. The requester accepting early, an admin closing, or the window elapsing.
  { from: 'resolved', to: 'closed', actors: ['requester', 'admin', 'sweep'] },
];

export function canTransition(from: SupportTicketStatus, to: SupportTicketStatus, actor: SupportActor): boolean {
  return SUPPORT_TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor));
}

/** The states in which a ticket still accepts messages and attachments. */
export const LIVE_SUPPORT_STATUSES: readonly SupportTicketStatus[] = ['open', 'assigned', 'awaiting_user'];

export function isLiveSupportStatus(status: SupportTicketStatus): boolean {
  return LIVE_SUPPORT_STATUSES.includes(status);
}

/** `closed` is the only terminal state, and this is the one place that is asserted. */
export function isTerminalSupportStatus(status: SupportTicketStatus): boolean {
  return status === 'closed';
}

/** The states an admin may still triage or assign from. */
export function isTriageableStatus(status: SupportTicketStatus): boolean {
  return isLiveSupportStatus(status);
}
