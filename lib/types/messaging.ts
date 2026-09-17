/**
 * Spec 025 §3 "Request and response types" — post-booking messaging & conversations.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`. Attachments are out of
 * scope (spec 027), so no DTO here carries attachment ids.
 */

export type ConversationParticipantRole = 'customer' | 'provider';

export interface ConversationParticipantDto {
  userId: string;
  role: ConversationParticipantRole;
  /** Business name for the provider. Customers have no display name in this schema, so `null`. Never a phone or email. */
  displayName: string | null;
  lastReadAt: string | null;
}

export interface ConversationDto {
  id: string;
  bookingId: string;
  participants: ConversationParticipantDto[];
  /** Derived from bookings.status (§3 "Active vs. archived"); false means read-only. */
  isActive: boolean;
  archivedAt: string | null;
  /** True once the booking has reached `confirmed` — drives the composer's guidance copy. */
  contactSharingAllowed: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  /** Messages from the OTHER participant newer than the caller's lastReadAt. */
  unreadCount: number;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderRole: ConversationParticipantRole;
  /** Stored form: masked while the booking is pre-`confirmed`, verbatim after. */
  body: string;
  /** AC-2: a contact pattern was masked before storage. */
  contactRedacted: boolean;
  /** AC-2: a contact pattern was detected and PERMITTED (post-confirmation). */
  contactFlagged: boolean;
  /** Set once the counterparty's lastReadAt reaches this message. Null otherwise. */
  readByCounterpartyAt: string | null;
  /** AC-4/AC-10: the body has been anonymized by a retention or deletion sweep. */
  redactedByRetention: boolean;
  createdAt: string;
}

export interface SendMessageRequest {
  /** Trimmed, 1–2000 characters, measured BEFORE redaction. */
  body: string;
}

export interface MarkConversationReadRequest {
  /** Must be a message in this conversation. */
  lastReadMessageId: string;
}

export interface ConversationReadStateDto {
  conversationId: string;
  lastReadAt: string;
  unreadCount: number;
}

/** Admin metadata view — deliberately carries NO message bodies. */
export interface AdminConversationDto {
  id: string;
  bookingId: string;
  participants: Array<{ userId: string; role: ConversationParticipantRole }>;
  isActive: boolean;
  archivedAt: string | null;
  retentionAppliedAt: string | null;
  messageCount: number;
  contactFlaggedCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

/** Admin message view. Same body the participants see — never an "unmasked" variant. */
export type AdminMessageDto = MessageDto;
