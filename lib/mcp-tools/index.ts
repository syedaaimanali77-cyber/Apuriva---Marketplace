/**
 * Spec 036 — MCP tool catalogue, idempotency and errors. The module's public surface.
 *
 * Deliberately NOT exported: any way to run a tool other than through spec 034's port and spec 035's
 * pipeline. Tools are reachable only by name through the registry.
 */
export { CATALOG_TOOLS, findCatalogTool, modelCatalogFor, registerMcpToolCatalog } from './catalog';
export { MCP_TOOLS_EXECUTOR } from './executor';
export { MCP_IDEMPOTENCY_KEY_REQUIRED, McpIdempotencyKeyRequiredError } from './errors';
export { REDACTED, type ToolField, type ToolFieldKind } from './fields';
export { MAX_AUTOMATIC_RETRIES } from './retry-policy';
export { removeAiToolCallsForDeletedUser } from './privacy';
export type { ToolOutputSummary } from './recorder';
export type { CatalogTool } from './tool';
