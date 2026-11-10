/**
 * Spec 032 §6 "Unit" — the state machine (AC-7, DECIDED-3).
 *
 * These assert the TABLE, not a sequence of calls, so a future edit that quietly adds a transition
 * has to justify itself against "closed is terminal" and "every actor is explicit" right here.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORT_TICKET_STATUSES, type SupportTicketStatus } from '@/lib/types/support';
import {
  canTransition,
  isLiveSupportStatus,
  isTerminalSupportStatus,
  SUPPORT_TRANSITIONS,
  type SupportActor,
} from './transitions';

const ACTORS: SupportActor[] = ['requester', 'admin', 'sweep'];

describe('support transition table', () => {
  it('is total: every (from, to, actor) triple answers true or false without throwing', () => {
    for (const from of SUPPORT_TICKET_STATUSES) {
      for (const to of SUPPORT_TICKET_STATUSES) {
        for (const actor of ACTORS) {
          expect(typeof canTransition(from, to, actor)).toBe('boolean');
        }
      }
    }
  });

  it('closed is terminal: no actor can leave it, super_admin included', () => {
    for (const to of SUPPORT_TICKET_STATUSES) {
      for (const actor of ACTORS) {
        expect(canTransition('closed', to, actor)).toBe(false);
      }
    }
    // And the table itself has no row with `closed` as a source, so there is nothing to grant.
    expect(SUPPORT_TRANSITIONS.some((t) => t.from === 'closed')).toBe(false);
    expect(isTerminalSupportStatus('closed')).toBe(true);
  });

  it('only an admin can assign, resolve or move a ticket to awaiting_user', () => {
    expect(canTransition('open', 'assigned', 'admin')).toBe(true);
    expect(canTransition('open', 'assigned', 'requester')).toBe(false);
    expect(canTransition('open', 'assigned', 'sweep')).toBe(false);

    expect(canTransition('assigned', 'awaiting_user', 'admin')).toBe(true);
    expect(canTransition('assigned', 'awaiting_user', 'requester')).toBe(false);

    for (const from of ['open', 'assigned', 'awaiting_user'] as SupportTicketStatus[]) {
      expect(canTransition(from, 'resolved', 'admin')).toBe(true);
      expect(canTransition(from, 'resolved', 'requester')).toBe(false);
      expect(canTransition(from, 'resolved', 'sweep')).toBe(false);
    }
  });

  it('a requester can answer an information request, reopen and close — and nothing else', () => {
    expect(canTransition('awaiting_user', 'assigned', 'requester')).toBe(true);
    expect(canTransition('resolved', 'assigned', 'requester')).toBe(true);
    expect(canTransition('resolved', 'closed', 'requester')).toBe(true);

    // Not their call:
    expect(canTransition('open', 'resolved', 'requester')).toBe(false);
    expect(canTransition('assigned', 'awaiting_user', 'requester')).toBe(false);
    expect(canTransition('assigned', 'assigned', 'requester')).toBe(false);
  });

  it('the sweep may only make an un-reopened resolution final', () => {
    expect(canTransition('resolved', 'closed', 'sweep')).toBe(true);
    // It is its own actor precisely so it cannot borrow the admin's powers.
    for (const from of SUPPORT_TICKET_STATUSES) {
      for (const to of SUPPORT_TICKET_STATUSES) {
        if (from === 'resolved' && to === 'closed') continue;
        expect(canTransition(from, to, 'sweep')).toBe(false);
      }
    }
  });

  it('reassignment is an explicit self-loop, so the table stays the single authority', () => {
    expect(canTransition('assigned', 'assigned', 'admin')).toBe(true);
    // No other self-loop exists.
    for (const status of SUPPORT_TICKET_STATUSES) {
      if (status === 'assigned') continue;
      for (const actor of ACTORS) expect(canTransition(status, status, actor)).toBe(false);
    }
  });

  it('a ticket accepts messages and attachments only while it is live', () => {
    expect(isLiveSupportStatus('open')).toBe(true);
    expect(isLiveSupportStatus('assigned')).toBe(true);
    expect(isLiveSupportStatus('awaiting_user')).toBe(true);
    expect(isLiveSupportStatus('resolved')).toBe(false);
    expect(isLiveSupportStatus('closed')).toBe(false);
  });
});
