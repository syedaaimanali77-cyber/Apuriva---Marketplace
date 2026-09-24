/** `get_service` — spec 010's `getServicePublic` (published services only). Low risk, read-only. */
import { getServicePublic } from '@/lib/catalog/services';
import type { ServiceDto } from '@/lib/types/catalog';
import { defineTool } from '../tool';

export const getServiceTool = defineTool<{ serviceId: string }, ServiceDto>({
  name: 'get_service',
  label: 'Look up a service',
  riskTier: 'low',
  reversible: false,
  modes: ['customer', 'provider'],
  stateChanging: false,
  fields: [{ name: 'serviceId', kind: 'uuid', required: true }],
  run: (input) => getServicePublic(input.serviceId),
  summarize: (service) => ({ type: 'service', id: service.id, status: service.status }),
});
