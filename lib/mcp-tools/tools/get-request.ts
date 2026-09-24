/**
 * `get_request` — the same reads the two request routes use, chosen by the caller's CURRENT mode
 * (resolved server-side, AC-8): spec 015's `getRequestForOwner` for a customer, spec 017's
 * `getIncomingRequest` for a provider (after `requireOwnProviderProfile`, exactly as
 * `GET /providers/me/requests/{id}` does). Low risk, read-only.
 */
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { getIncomingRequest } from '@/lib/matching/provider-requests';
import { getRequestForOwner } from '@/lib/requests/read';
import type { IncomingRequestDto } from '@/lib/types/matching';
import type { RequestDto } from '@/lib/types/requests';
import { defineTool } from '../tool';

export const getRequestTool = defineTool<{ requestId: string }, RequestDto | IncomingRequestDto>({
  name: 'get_request',
  label: 'Look up a request',
  riskTier: 'low',
  reversible: false,
  modes: ['customer', 'provider'],
  stateChanging: false,
  fields: [{ name: 'requestId', kind: 'uuid', required: true }],
  async run(input, context) {
    if (context.activeMode === 'provider') {
      const profile = await requireOwnProviderProfile(context.userId);
      return getIncomingRequest(profile.id, input.requestId);
    }
    return getRequestForOwner(context.userId, input.requestId);
  },
  // A provider's view carries no request status, so none is recorded rather than one inferred.
  summarize: (request, input) => ({ type: 'request', id: input.requestId, status: 'status' in request ? request.status : null }),
  related: (input) => ({ type: 'request', id: input.requestId }),
});
