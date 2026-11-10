/**
 * Spec 035 §3 shared types. They live here, in `lib/types/`, for the same reason every other
 * shared DTO does: the admin page is a client component and must not import `lib/mcp`, which
 * reaches the database and the registry.
 *
 * Only METADATA crosses this boundary — never a tool's input, output or call history.
 */
import type { AiProposedRiskTier } from '@/lib/ai-assistant/risk-policy';
import type { ActiveMode } from '@/lib/types/users';

/** What `GET /api/v1/admin/mcp/tools` returns for each registered tool. */
export interface McpToolMetadataDto {
  name: string;
  riskTier: AiProposedRiskTier;
  /** Plain language, as spec 034 shows it in activity history (master spec §85). */
  label: string;
  /** Whether the effect can be undone (master spec §86). */
  reversible: boolean;
  adminOnly: boolean;
  modes: ActiveMode[];
  requiresConfirmation: boolean;
  isIdempotent: boolean;
}
