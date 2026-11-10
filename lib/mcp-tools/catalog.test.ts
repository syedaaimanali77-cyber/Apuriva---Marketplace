import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAiActionExecutor } from '@/lib/ai-assistant/executor';
import { requiresConfirmation } from '@/lib/ai-assistant/risk-policy';
import { findUserTool, listMcpToolMetadata } from '@/lib/mcp';
import { resetMcpRegistryForTests } from '@/lib/mcp/registry';
import { assertCatalogToolValid, CATALOG_TOOLS, modelCatalogFor, registerMcpToolCatalog } from './catalog';
import { MCP_TOOLS_EXECUTOR } from './executor';
import { defineTool } from './tool';
import { resetToolCatalog } from './mcp-tools-test-support';

/** Spec 036 AC-1 — exactly the ten registrable tools, each with the tier master spec §87 documents. */
const EXPECTED = {
  search_services: { tier: 'low', modes: ['customer', 'provider'], stateChanging: false },
  get_service: { tier: 'low', modes: ['customer', 'provider'], stateChanging: false },
  get_provider_availability: { tier: 'low', modes: ['customer', 'provider'], stateChanging: false },
  get_request: { tier: 'low', modes: ['customer', 'provider'], stateChanging: false },
  get_booking: { tier: 'low', modes: ['customer', 'provider'], stateChanging: false },
  get_provider_earnings: { tier: 'low', modes: ['provider'], stateChanging: false },
  get_notifications: { tier: 'low', modes: ['customer', 'provider'], stateChanging: false },
  create_booking: { tier: 'high', modes: ['customer'], stateChanging: true },
  cancel_booking: { tier: 'high', modes: ['customer', 'provider'], stateChanging: true },
  authorize_payment: { tier: 'high', modes: ['customer'], stateChanging: true },
} as const;

/** Spec 036 §7 — mapped but deliberately NOT registered. */
const DEFERRED = [
  'send_offer',
  'accept_offer',
  'request_offer_change',
  'mark_provider_arrived',
  'start_service',
  'complete_service',
  'create_support_ticket',
  'submit_review',
  'send_provider_message',
  'create_service_request',
  'get_offers',
  'search_providers',
  'get_provider',
  'get_customer_profile',
];

describe('spec 036 catalogue (AC-1)', () => {
  beforeEach(async () => {
    resetMcpRegistryForTests();
    await registerMcpToolCatalog();
  });
  afterEach(resetToolCatalog);

  it('registers exactly the ten available, tier-documented tools', () => {
    expect(CATALOG_TOOLS.map((tool) => tool.definition.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(listMcpToolMetadata().map((tool) => tool.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('registers none of the deferred tools', () => {
    for (const name of DEFERRED) expect(findUserTool(name), name).toBeUndefined();
  });

  it('declares the documented tier, the route modes and state-changing-ness for every tool', () => {
    for (const tool of CATALOG_TOOLS) {
      const expected = EXPECTED[tool.definition.name as keyof typeof EXPECTED];
      expect(tool.definition.riskTier, tool.definition.name).toBe(expected.tier);
      expect([...tool.definition.modes].sort(), tool.definition.name).toEqual([...expected.modes].sort());
      expect(tool.stateChanging, tool.definition.name).toBe(expected.stateChanging);
      expect(tool.definition.isIdempotent, tool.definition.name).toBe(expected.stateChanging);
      // Derived from spec 034's mapping, never restated by hand.
      expect(tool.definition.requiresConfirmation).toBe(requiresConfirmation(tool.definition.riskTier));
      expect(tool.definition.adminOnly).toBe(false);
      expect(tool.definition.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('every confirmable tool binds only safe values and declares its §90 card, without Location', () => {
    for (const tool of CATALOG_TOOLS.filter((t) => t.definition.requiresConfirmation)) {
      expect(() => assertCatalogToolValid(tool)).not.toThrow();
      expect(tool.displayLabels).toEqual(['Service', 'Provider', 'Date/time', 'Price']);
    }
  });

  it('registration refuses a confirmable tool that would bind free text, or whose field collides with a display label', () => {
    const base = {
      label: 'Test',
      riskTier: 'high' as const,
      reversible: false,
      modes: ['customer'] as const,
      stateChanging: true,
      displayLabels: ['Service'],
      display: async () => [],
      run: async () => null,
      summarize: () => null,
    };
    const freeText = defineTool({ ...base, name: 'free_text_probe', fields: [{ name: 'note', kind: 'text', required: true }] });
    expect(() => assertCatalogToolValid(freeText)).toThrow(/not a safe value/);
    const collision = defineTool({ ...base, name: 'collision_probe', fields: [{ name: 'Service', kind: 'uuid', required: true }] });
    expect(() => assertCatalogToolValid(collision)).toThrow(/collides with a display label/);
  });

  it('makes this spec’s executor the one spec 034’s port uses', () => {
    expect(getAiActionExecutor()).toBe(MCP_TOOLS_EXECUTOR);
  });

  it('registering twice is harmless (the catalogue is registered once per process)', async () => {
    await expect(registerMcpToolCatalog()).resolves.toBeUndefined();
    expect(listMcpToolMetadata()).toHaveLength(10);
  });
});

describe('spec 036 model-facing catalogue', () => {
  beforeEach(async () => {
    resetMcpRegistryForTests();
    await registerMcpToolCatalog();
  });
  afterEach(resetToolCatalog);

  it('exposes names, labels and input field kinds only — no validator, no execution logic', () => {
    for (const entry of modelCatalogFor('customer')) {
      expect(Object.keys(entry).sort()).toEqual(['input', 'label', 'name']);
      for (const field of entry.input) {
        expect(Object.keys(field).every((key) => ['name', 'kind', 'required', 'values'].includes(key))).toBe(true);
      }
    }
  });

  it('offers only the tools available in the caller’s mode', () => {
    const customer = modelCatalogFor('customer').map((tool) => tool.name);
    const provider = modelCatalogFor('provider').map((tool) => tool.name);
    expect(customer).toContain('create_booking');
    expect(customer).toContain('authorize_payment');
    expect(customer).not.toContain('get_provider_earnings');
    expect(provider).toContain('get_provider_earnings');
    expect(provider).toContain('cancel_booking');
    expect(provider).not.toContain('create_booking');
    expect(provider).not.toContain('authorize_payment');
  });

  it('never mentions an idempotency key — the AI never supplies or controls one', () => {
    const fields = modelCatalogFor('customer').flatMap((tool) => tool.input.map((field) => field.name.toLowerCase()));
    expect(fields.some((name) => name.includes('idempotency'))).toBe(false);
  });

  it('offers nothing that is not registered', () => {
    resetMcpRegistryForTests();
    expect(modelCatalogFor('customer')).toEqual([]);
  });
});
