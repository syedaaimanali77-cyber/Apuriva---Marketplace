/**
 * Spec 035 — MCP tool architecture and authorization. The module's public surface.
 *
 * Deliberately NOT exported: nothing here lets a caller run a tool while skipping the pipeline.
 * `authorizeAndExecute` is the one entry point, and spec 034's port is the one caller.
 */
export type {
  McpAuthContext,
  McpBoundParameter,
  McpCheckOutcome,
  McpToolDefinition,
  McpToolMetadataDto,
  McpToolResult,
} from './types';

export { MCP_AUTHORIZATION_CHECKS, authorizeAndExecute, type McpCallRequest } from './authorize';
export {
  MCP_AUTHORIZATION_FAILED,
  MCP_CONFIRMATION_STALE,
  MCP_SCHEMA_VALIDATION_FAILED,
  MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT,
} from './errors';
export {
  MCP_CONFIRMATION_TTL_MS,
  bindingMatches,
  createMcpConfirmation,
  readMcpConfirmation,
  resolveMcpConfirmation,
  type McpConfirmationRecord,
} from './confirmation';
export { findAdminTool, findUserTool, listMcpToolMetadata, listMcpTools, registerMcpTool } from './registry';
export { MCP_READ_REGISTRY_ACTION, MCP_RESOURCE, requireMcpRegistryPermission } from './permissions';
export { registerMcpAuditSink, type McpAuditEntry, type McpAuditSink } from './audit';
export { mcpAuthContextFor, registerMcpIntegration, resolveSessionActiveMode } from './executor';
export { mcpConfirmationStaleError, mcpToolNotAvailableInContextError } from './errors';
export {
  requireEnum,
  requireExactFields,
  requireIntegerMinorUnits,
  requireObject,
  requireString,
  requireUuid,
} from './validation';
