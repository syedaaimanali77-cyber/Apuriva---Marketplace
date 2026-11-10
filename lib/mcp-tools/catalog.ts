/**
 * Spec 036 §3 "Registered catalogue" — EXACTLY these ten tools (AC-1), and no other.
 *
 * Deferred, deliberately NOT here (spec 036 §7): the eight tools with an undocumented risk tier
 * (send_offer, accept_offer, request_offer_change, mark_provider_arrived, start_service,
 * complete_service, create_support_ticket, submit_review); send_provider_message and
 * create_service_request, whose confirmed input would need free text; get_offers, whose only domain
 * read (spec 018's `listOffersForCustomer`) marks offers viewed — a mutation AC-5 forbids a read
 * tool; and the capability gaps search_providers, get_provider and get_customer_profile.
 */
import type { AiModelTool } from '@/lib/ai-assistant/executor';
import { registerAiActionExecutor } from '@/lib/ai-assistant/executor';
import { findUserTool, registerMcpTool } from '@/lib/mcp';
import type { ActiveMode } from '@/lib/types/users';
import { describeFields, isSafeKind } from './fields';
import type { CatalogTool } from './tool';
import { authorizePaymentTool } from './tools/authorize-payment';
import { cancelBookingTool } from './tools/cancel-booking';
import { createBookingTool } from './tools/create-booking';
import { getBookingTool } from './tools/get-booking';
import { getNotificationsTool } from './tools/get-notifications';
import { getProviderAvailabilityTool } from './tools/get-provider-availability';
import { getProviderEarningsTool } from './tools/get-provider-earnings';
import { getRequestTool } from './tools/get-request';
import { getServiceTool } from './tools/get-service';
import { searchServicesTool } from './tools/search-services';

export const CATALOG_TOOLS: readonly CatalogTool<any, any>[] = [
  searchServicesTool,
  getServiceTool,
  getProviderAvailabilityTool,
  getRequestTool,
  getBookingTool,
  getProviderEarningsTool,
  getNotificationsTool,
  createBookingTool,
  cancelBookingTool,
  authorizePaymentTool,
];

const BY_NAME = new Map(CATALOG_TOOLS.map((tool) => [tool.definition.name, tool]));

export function findCatalogTool(name: string): CatalogTool<any, any> | undefined {
  return BY_NAME.get(name);
}

/**
 * Registration-time invariants of spec 036 §3 contract 1, checked once, loudly:
 *   - a confirmable tool binds ONLY safe kinds (no free text, no plain numbers), so nothing
 *     sensitive can ever reach `mcp_confirmation_parameters`;
 *   - a confirmable tool declares its display labels and has a `display`;
 *   - no input field name equals a display label, so binding rows and display rows are never
 *     ambiguous within spec 035's unique `(confirmation, label)`.
 */
export function assertCatalogToolValid(tool: CatalogTool<any, any>): void {
  const { name, requiresConfirmation } = tool.definition;
  if (tool.stateChanging !== tool.definition.isIdempotent) throw new Error(`Catalogue tool "${name}" misdeclares idempotency.`);
  if (!requiresConfirmation) return;
  if (!tool.display || tool.displayLabels.length === 0) throw new Error(`Confirmable tool "${name}" needs display rows (master spec §90).`);
  for (const field of tool.fields) {
    if (!isSafeKind(field.kind)) throw new Error(`Confirmable tool "${name}" cannot bind "${field.name}" (${field.kind}) — not a safe value.`);
    if (tool.displayLabels.includes(field.name)) throw new Error(`Confirmable tool "${name}": field "${field.name}" collides with a display label.`);
  }
}

/**
 * The model-facing catalogue for a mode (spec 036 §3): name, plain-language label, and the names and
 * value kinds of each input field. No validators, no execution logic, no admin tool, and only tools
 * actually registered in the USER registry.
 */
export function modelCatalogFor(mode: ActiveMode): AiModelTool[] {
  return CATALOG_TOOLS.filter((tool) => tool.definition.modes.includes(mode) && findUserTool(tool.definition.name) === tool.definition).map(
    (tool) => ({ name: tool.definition.name, label: tool.definition.label, input: describeFields(tool.fields) }),
  );
}

/**
 * Called once from `instrumentation.ts`, AFTER spec 035's `registerMcpIntegration`: registers every
 * catalogue tool in spec 035's USER registry and makes this spec's executor the one spec 034's port
 * uses. Safe to call again (a test suite does): a tool already registered as itself is skipped.
 */
export async function registerMcpToolCatalog(): Promise<void> {
  for (const tool of CATALOG_TOOLS) {
    assertCatalogToolValid(tool);
    if (findUserTool(tool.definition.name) === tool.definition) continue;
    registerMcpTool(tool.definition);
  }
  const { MCP_TOOLS_EXECUTOR } = await import('./executor');
  registerAiActionExecutor(MCP_TOOLS_EXECUTOR);
}
