import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requiresConfirmation } from '@/lib/ai-assistant/risk-policy';
import { findAdminTool, findUserTool, listMcpToolMetadata, listMcpTools, registerMcpTool } from './registry';
import { registerTestTool, resetMcpTestState } from './mcp-test-support';
import type { McpToolDefinition } from './types';

/** Spec 035 §3 — the registry, AC-5 (admin separation) and AC-7 (label + reversibility). */
describe('spec 035 tool registry', () => {
  beforeEach(resetMcpTestState);
  afterEach(resetMcpTestState);

  it('AC-5: admin tools are unreachable from the user registry, whatever their name', () => {
    registerTestTool({ name: 'admin_only_tool', adminOnly: true, permission: { resource: 'mcp', action: 'read_registry' } });

    // The lookup a conversation uses does not know the tool exists at all — separation by registry,
    // not by a flag a caller could forget to check.
    expect(findUserTool('admin_only_tool')).toBeUndefined();
    expect(findAdminTool('admin_only_tool')).toBeDefined();
  });

  it('AC-5: a user tool and an admin tool may share a name without either leaking', () => {
    registerTestTool({ name: 'same_name' });
    registerTestTool({ name: 'same_name', adminOnly: true, permission: { resource: 'mcp', action: 'read_registry' } });

    expect(findUserTool('same_name')?.adminOnly).toBe(false);
    expect(findAdminTool('same_name')?.adminOnly).toBe(true);
  });

  it('AC-7: every tool declares a plain-language label and whether it is reversible', () => {
    registerTestTool({ name: 'labelled', reversible: false });

    for (const tool of listMcpTools()) {
      expect(tool.label.trim().length).toBeGreaterThan(0);
      expect(typeof tool.reversible).toBe('boolean');
    }
    expect(listMcpToolMetadata().find((tool) => tool.name === 'labelled')?.reversible).toBe(false);
  });

  it('AC-7: a tool with no label is refused at registration, not discovered at runtime', () => {
    const unlabelled = {
      name: 'unlabelled',
      riskTier: 'low',
      label: '   ',
      reversible: true,
      adminOnly: false,
      modes: ['customer'],
      requiresConfirmation: false,
      isIdempotent: true,
      validate: (raw: unknown) => raw,
      execute: async () => ({}),
    } as unknown as McpToolDefinition;

    expect(() => registerMcpTool(unlabelled)).toThrow(/plain-language label/);
  });

  it('a tool may not contradict spec 034 on whether its tier needs confirmation', () => {
    const lying = {
      name: 'lying_tool',
      riskTier: 'high',
      label: 'Lying tool',
      reversible: false,
      adminOnly: false,
      modes: ['customer'],
      requiresConfirmation: false, // spec 034 says high ALWAYS confirms
      isIdempotent: false,
      validate: (raw: unknown) => raw,
      execute: async () => ({}),
    } as unknown as McpToolDefinition;

    expect(() => registerMcpTool(lying)).toThrow(/contradicts spec 034/);
    expect(requiresConfirmation('high')).toBe(true);
  });

  it('an admin tool without a spec 009 permission is refused — check 7 would pass vacuously', () => {
    expect(() => registerTestTool({ name: 'no_permission', adminOnly: true })).toThrow(/must declare a spec 009 permission/);
  });

  it('a duplicate name in the same registry is refused', () => {
    registerTestTool({ name: 'dupe' });
    expect(() => registerTestTool({ name: 'dupe' })).toThrow(/already registered/);
  });

  it('metadata carries no tool internals — no validate, no execute, no input shape', () => {
    registerTestTool({ name: 'meta_tool' });
    const [metadata] = listMcpToolMetadata().filter((tool) => tool.name === 'meta_tool');

    expect(Object.keys(metadata!).sort()).toEqual(
      ['adminOnly', 'isIdempotent', 'label', 'modes', 'name', 'requiresConfirmation', 'reversible', 'riskTier'].sort(),
    );
  });
});
