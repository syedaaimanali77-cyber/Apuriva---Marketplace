/**
 * `get_notifications` — spec 026's `listNotifications` for the caller's own inbox. It only READS:
 * marking read is a separate spec 026 function this tool never calls. Low risk, read-only.
 */
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/pagination';
import { listNotifications } from '@/lib/notifications';
import { defineTool } from '../tool';

type NotificationPage = Awaited<ReturnType<typeof listNotifications>>;

export const getNotificationsTool = defineTool<{ unreadOnly?: boolean; limit?: number; offset?: number }, NotificationPage>({
  name: 'get_notifications',
  label: 'Check notifications',
  riskTier: 'low',
  reversible: false,
  modes: ['customer', 'provider'],
  stateChanging: false,
  fields: [
    { name: 'unreadOnly', kind: 'boolean', required: false },
    { name: 'limit', kind: 'integer', required: false, min: 1, max: MAX_PAGE_LIMIT },
    { name: 'offset', kind: 'integer', required: false, min: 0 },
  ],
  run: (input, context) =>
    listNotifications(
      context.userId,
      { limit: input.limit ?? DEFAULT_PAGE_LIMIT, offset: input.offset ?? 0 },
      { unreadOnly: input.unreadOnly ?? false },
    ),
  summarize: () => null,
});
