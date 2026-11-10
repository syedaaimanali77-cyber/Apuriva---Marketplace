/**
 * Spec 025 §3 "Incremental reads for live update" — the `after=<createdAtISO>|<id>` delta cursor.
 *
 * PURE. Exact because message `created_at` is stored at millisecond precision and strictly increasing
 * per conversation (§3 "Ordering"), so an ISO string round-trips it without loss.
 */
import { validationError } from '@/lib/api/errors';

export interface MessageCursor {
  createdAt: Date;
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function formatMessageCursor(message: { createdAt: string; id: string }): string {
  return `${message.createdAt}|${message.id}`;
}

/** Throws `400 VALIDATION_ERROR` for anything malformed — never silently ignored. */
export function parseMessageCursor(raw: string): MessageCursor {
  const separator = raw.lastIndexOf('|');
  const iso = separator > 0 ? raw.slice(0, separator) : '';
  const id = separator > 0 ? raw.slice(separator + 1) : '';
  const createdAt = new Date(iso);
  if (!ISO_PATTERN.test(iso) || Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw validationError([{ field: 'after', message: 'must be "<ISO-8601 UTC timestamp>|<message id>"' }]);
  }
  return { createdAt, id: id.toLowerCase() };
}
