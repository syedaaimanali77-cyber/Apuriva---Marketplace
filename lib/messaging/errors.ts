/**
 * Spec 025 §3 "Error codes" — the codes new to this spec. Codes reused from earlier specs are re-exported
 * from their owners rather than redefined, so each keeps exactly one definition.
 */
import { ApiRouteError } from '@/lib/api/errors';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';

/**
 * `404` — the booking does not exist, the caller is not one of its two participants, or the id is not a
 * uuid. Deliberately indistinguishable, so conversation existence is not probeable.
 */
export function conversationNotFoundError(): ApiRouteError {
  return new ApiRouteError('CONVERSATION_NOT_FOUND', 'There is no conversation here.', { status: 404 });
}

/** `422` — the booking has reached `settled`/`cancelled`/`refunded`/`failed`. Reads still succeed. */
export function conversationArchivedError(): ApiRouteError {
  return new ApiRouteError('CONVERSATION_ARCHIVED', 'This conversation is closed. You can still read it.', { status: 422 });
}

/**
 * `403` — an active block between the participants (AC-6). Defined once, here; spec 030 declares the
 * same code and re-exports this definition when it ships.
 */
export function blockedError(): ApiRouteError {
  return new ApiRouteError('BLOCKED', 'You can no longer send messages in this conversation.', { status: 403 });
}

/** `422` — `lastReadMessageId` names a message that is not in this conversation. */
export function messageNotInConversationError(): ApiRouteError {
  return new ApiRouteError('MESSAGE_NOT_IN_CONVERSATION', 'That message is not part of this conversation.', {
    status: 422,
  });
}
