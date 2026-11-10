/**
 * Spec 035 §3 "Error codes" — this spec's additions to spec 004's taxonomy. None is in the
 * baseline `API_ERROR_CODES` map, so each passes `status` explicitly, exactly as specs 005, 033
 * and 034 do for their own codes.
 *
 * | HTTP | code                             | when                                              |
 * |------|----------------------------------|---------------------------------------------------|
 * | 403  | MCP_AUTHORIZATION_FAILED         | any of the eight checks fails                      |
 * | 403  | MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT| admin tool from a user context; wrong active mode  |
 * | 409  | MCP_CONFIRMATION_STALE           | bound parameters changed, or the binding expired   |
 * | 400  | MCP_SCHEMA_VALIDATION_FAILED     | input does not match the tool's strict schema      |
 *
 * A failure message NEVER quotes tool input back: input may contain attacker-supplied text
 * (master spec §93) and, for a payment or account tool, is as sensitive as the domain data itself
 * (spec 035 §4 "Retention and privacy").
 */
import { ApiRouteError } from '@/lib/api/errors';

export const MCP_AUTHORIZATION_FAILED = 'MCP_AUTHORIZATION_FAILED';
export const MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT = 'MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT';
export const MCP_CONFIRMATION_STALE = 'MCP_CONFIRMATION_STALE';
export const MCP_SCHEMA_VALIDATION_FAILED = 'MCP_SCHEMA_VALIDATION_FAILED';

/**
 * One deliberately uninformative message for every one of the eight checks. Which check failed is
 * recorded server-side (the audit entry and the security log); telling a caller that ownership
 * passed but permission scope did not is an oracle for probing someone else's data.
 */
export function mcpAuthorizationFailedError(): ApiRouteError {
  return new ApiRouteError(MCP_AUTHORIZATION_FAILED, 'This action is not allowed.', { status: 403 });
}

export function mcpToolNotAvailableInContextError(): ApiRouteError {
  return new ApiRouteError(MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT, 'This action is not available here.', { status: 403 });
}

/** AC-3. The user must be asked again, against the parameters as they now stand. */
export function mcpConfirmationStaleError(): ApiRouteError {
  return new ApiRouteError(MCP_CONFIRMATION_STALE, 'Please confirm again — the details changed.', { status: 409 });
}

/**
 * Carries spec 004's field-level `errors[]` shape, so a caller sees WHICH field was wrong without
 * the value being echoed back.
 */
export function mcpSchemaValidationFailedError(errors: { field: string; message: string }[]): ApiRouteError {
  return new ApiRouteError(MCP_SCHEMA_VALIDATION_FAILED, 'The action could not be prepared.', {
    status: 400,
    errors,
  });
}
