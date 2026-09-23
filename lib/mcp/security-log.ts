/**
 * Spec 035 AC-6 / master spec §93 ("log suspicious tool patterns") — structured stdout, the exact
 * convention `lib/api/security-log.ts` (spec 004) established: this module persists nothing
 * itself, and spec 046's pipeline collects what it writes. Spec 039 may later persist
 * security-relevant attempts; that is its decision, not a second logging path built here.
 *
 * NOTHING logged here contains tool input. A rejected call's arguments may be attacker-supplied
 * text or payment-sensitive data (spec 035 §4), so only the tool name, the check that failed and
 * the subject are recorded.
 */

/** Which of the eight checks refused the call. The order here is the order they run in. */
export type McpCheckName =
  | 'authenticated_identity'
  | 'role_mode'
  | 'resource_ownership'
  | 'booking_request_context'
  | 'tool_risk'
  | 'required_confirmation'
  | 'permission_scope'
  | 'audit_requirement';

export function logMcpAuthorizationFailure(params: {
  toolName: string;
  check: McpCheckName;
  userId: string;
  reason: string;
}): void {
  console.warn(
    JSON.stringify({
      event: 'mcp.authorization_failed',
      tool: params.toolName,
      check: params.check,
      userId: params.userId,
      reason: params.reason,
      at: new Date().toISOString(),
    }),
  );
}

/**
 * A pattern worth a human's attention rather than a single refusal: an identity field supplied in
 * tool input, an unknown tool name from a user context, or a confirmation presented for a tool it
 * was not issued for. Each is a tampering signature, not an ordinary mistake.
 */
export function logMcpSuspiciousPattern(params: {
  toolName: string;
  userId: string;
  pattern: 'identity_field_in_input' | 'unknown_tool' | 'admin_tool_from_user_context' | 'confirmation_mismatch';
  detail: string;
}): void {
  console.warn(
    JSON.stringify({
      event: 'mcp.suspicious_pattern',
      tool: params.toolName,
      userId: params.userId,
      pattern: params.pattern,
      detail: params.detail,
      at: new Date().toISOString(),
    }),
  );
}
