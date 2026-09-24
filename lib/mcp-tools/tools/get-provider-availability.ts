/** `get_provider_availability` — spec 016's `getAvailabilitySummary`. Low risk, read-only. */
import { getAvailabilitySummary } from '@/lib/availability/summary';
import type { AvailabilitySummaryDto } from '@/lib/types/availability';
import { defineTool } from '../tool';

export const getProviderAvailabilityTool = defineTool<{ providerProfileId: string }, AvailabilitySummaryDto>({
  name: 'get_provider_availability',
  label: 'Check provider availability',
  riskTier: 'low',
  reversible: false,
  modes: ['customer', 'provider'],
  stateChanging: false,
  fields: [{ name: 'providerProfileId', kind: 'uuid', required: true }],
  run: (input) => getAvailabilitySummary(input.providerProfileId),
  summarize: (summary, input) => ({ type: 'provider_availability', id: input.providerProfileId, status: summary.state }),
});
