/**
 * Spec 035 §3 — the tool registry.
 *
 * TWO registries, deliberately separate (AC-5): a user conversation can only ever look up a tool
 * in the user registry, so an admin tool is not merely refused there — it is not reachable at all.
 * Separation by lookup beats separation by flag: a forgotten flag check is a privilege escalation,
 * a missing map entry is a miss.
 *
 * THIS SPEC REGISTERS NO BUSINESS TOOL. The catalogue of read/action tools is spec 036's (§7), so
 * both registries ship empty and the assistant proposes nothing until 036 lands — the honest state
 * of a surface with no tools (master spec §132.8). `lib/mcp/boundary.test.ts` asserts it stays
 * that way.
 */
import { requiresConfirmation } from '@/lib/ai-assistant/risk-policy';
import type { McpToolDefinition, McpToolMetadataDto } from './types';

const userTools = new Map<string, McpToolDefinition<any, any>>();
const adminTools = new Map<string, McpToolDefinition<any, any>>();

function registryFor(adminOnly: boolean): Map<string, McpToolDefinition<any, any>> {
  return adminOnly ? adminTools : userTools;
}

/**
 * Registration-time invariants. Each is a rule the pipeline would otherwise have to trust a tool
 * author to have got right, so it is checked once, loudly, at startup rather than per call.
 */
function assertValid(tool: McpToolDefinition<any, any>): void {
  if (tool.name.trim().length === 0) throw new Error('An MCP tool needs a name.');
  if (tool.label.trim().length === 0) throw new Error(`MCP tool "${tool.name}" needs a plain-language label (master spec §85).`);
  if (tool.modes.length === 0) throw new Error(`MCP tool "${tool.name}" must allow at least one mode.`);
  // Spec 034 owns the tier→confirmation mapping; a tool may restate it but never contradict it.
  if (tool.requiresConfirmation !== requiresConfirmation(tool.riskTier)) {
    throw new Error(
      `MCP tool "${tool.name}" declares requiresConfirmation=${tool.requiresConfirmation}, which contradicts spec 034's mapping for tier "${tool.riskTier}".`,
    );
  }
  // Check 7 needs something to resolve for an admin tool; without it the check would pass vacuously.
  if (tool.adminOnly && tool.permission === undefined) {
    throw new Error(`Admin MCP tool "${tool.name}" must declare a spec 009 permission for check 7.`);
  }
  if (registryFor(tool.adminOnly).has(tool.name)) throw new Error(`MCP tool "${tool.name}" is already registered.`);
}

export function registerMcpTool<TInput, TOutput>(tool: McpToolDefinition<TInput, TOutput>): void {
  assertValid(tool);
  registryFor(tool.adminOnly).set(tool.name, tool);
}

/**
 * The ONLY lookup a user conversation may use. An admin tool's name resolves to `undefined` here
 * however it was spelled, which is what makes AC-5 structural.
 */
export function findUserTool(name: string): McpToolDefinition<any, any> | undefined {
  return userTools.get(name);
}

export function findAdminTool(name: string): McpToolDefinition<any, any> | undefined {
  return adminTools.get(name);
}

export function listMcpTools(): McpToolDefinition<any, any>[] {
  return [...userTools.values(), ...adminTools.values()];
}

/** Metadata for the admin registry view. Never exposes `validate`, `execute` or any input shape. */
export function listMcpToolMetadata(): McpToolMetadataDto[] {
  return listMcpTools()
    .map((tool) => ({
      name: tool.name,
      riskTier: tool.riskTier,
      label: tool.label,
      reversible: tool.reversible,
      adminOnly: tool.adminOnly,
      modes: [...tool.modes],
      requiresConfirmation: tool.requiresConfirmation,
      isIdempotent: tool.isIdempotent,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Test-only: registries are module state, so a suite must be able to start from empty. */
export function resetMcpRegistryForTests(): void {
  userTools.clear();
  adminTools.clear();
}
