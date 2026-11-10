/**
 * `get_provider_earnings` — spec 024's `earningsSummary` over `resolveDateRange`, the same pair
 * `GET /api/v1/providers/me/earnings` calls, for the caller's OWN provider profile only. Provider
 * mode; low risk, read-only.
 */
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { earningsSummary, resolveDateRange } from '@/lib/payouts';
import { defineTool } from '../tool';

type EarningsSummary = Awaited<ReturnType<typeof earningsSummary>>;

export const getProviderEarningsTool = defineTool<{ currency?: string; from?: string; to?: string }, EarningsSummary>({
  name: 'get_provider_earnings',
  label: 'Check earnings',
  riskTier: 'low',
  reversible: false,
  modes: ['provider'],
  stateChanging: false,
  fields: [
    { name: 'currency', kind: 'currency', required: false },
    { name: 'from', kind: 'date', required: false },
    { name: 'to', kind: 'date', required: false },
  ],
  async run(input, context) {
    const profile = await requireOwnProviderProfile(context.userId);
    const range = await resolveDateRange(profile.id, input.from ?? null, input.to ?? null);
    return earningsSummary(profile.id, { currency: input.currency ?? null, range });
  },
  summarize: () => null,
});
