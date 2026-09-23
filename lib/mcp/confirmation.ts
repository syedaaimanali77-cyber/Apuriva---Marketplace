/**
 * Spec 035 §4 / AC-3 — the confirmation record: parameter binding, expiry, staleness.
 *
 * Master spec §90: a confirmation is bound to EXACT parameters (provider, service, date/time,
 * location, price, currency) and "if parameters change, confirmation must be obtained again".
 * That comparison is made here, server-side, against what was stored when the user was asked —
 * never against anything the model reports (AC-2).
 *
 * Spec 034's `ai_actions` is not read or written by this module. The only thing the two specs
 * share is the opaque id spec 034 carries as `confirmationId`.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { mcpConfirmationParameters, mcpConfirmations } from '@/lib/db/schema';
import type { McpBoundParameter } from './types';

/**
 * How long an unanswered confirmation stays valid.
 *
 * 15 minutes, matching spec 007's `RESUME_STATE_TTL_MS` — the repository's existing answer to the
 * same shape of problem, a short-lived server-side record holding a pending user intention across
 * a UI step. The finalized spec requires an expiry but fixes no duration, so this follows the
 * nearest existing convention rather than inventing a new number.
 */
export const MCP_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export type McpConfirmationRiskTier = 'medium' | 'high';

export interface McpConfirmationRecord {
  id: string;
  userId: string;
  toolName: string;
  riskTier: McpConfirmationRiskTier;
  parameters: McpBoundParameter[];
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Why a confirmation cannot be used. Each maps to a different outcome for the caller. */
export type McpConfirmationRejection = 'not_found' | 'expired' | 'consumed' | 'tool_mismatch' | 'parameters_changed';

export type McpConfirmationResolution =
  | { ok: true; record: McpConfirmationRecord }
  | { ok: false; rejection: McpConfirmationRejection };

/**
 * Issues a binding for a proposed medium/high action. The returned id is opaque: it carries no
 * tool name, no user id and no parameter, so it discloses nothing if it leaks into a transcript.
 */
export async function createMcpConfirmation(input: {
  userId: string;
  toolName: string;
  riskTier: McpConfirmationRiskTier;
  parameters: McpBoundParameter[];
  now?: Date;
}): Promise<McpConfirmationRecord> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + MCP_CONFIRMATION_TTL_MS);

  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(mcpConfirmations)
      .values({
        id: randomUUID(),
        userId: input.userId,
        toolName: input.toolName,
        riskTier: input.riskTier,
        expiresAt,
      })
      .returning({ id: mcpConfirmations.id });

    const confirmationId = row!.id;
    if (input.parameters.length > 0) {
      await tx.insert(mcpConfirmationParameters).values(
        input.parameters.map((parameter, index) => ({
          id: randomUUID(),
          mcpConfirmationId: confirmationId,
          label: parameter.label,
          value: parameter.value,
          sortOrder: index,
        })),
      );
    }

    return {
      id: confirmationId,
      userId: input.userId,
      toolName: input.toolName,
      riskTier: input.riskTier,
      parameters: [...input.parameters],
      expiresAt,
      consumedAt: null,
    };
  });
}

/** Reads a binding and its parameters. Scoped to the owner: another user's id resolves to null. */
export async function readMcpConfirmation(confirmationId: string, userId: string): Promise<McpConfirmationRecord | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: mcpConfirmations.id,
      userId: mcpConfirmations.userId,
      toolName: mcpConfirmations.toolName,
      riskTier: mcpConfirmations.riskTier,
      expiresAt: mcpConfirmations.expiresAt,
      consumedAt: mcpConfirmations.consumedAt,
    })
    .from(mcpConfirmations)
    .where(and(eq(mcpConfirmations.id, confirmationId), eq(mcpConfirmations.userId, userId)));
  if (!row) return null;

  const parameters = await db
    .select({ label: mcpConfirmationParameters.label, value: mcpConfirmationParameters.value })
    .from(mcpConfirmationParameters)
    .where(eq(mcpConfirmationParameters.mcpConfirmationId, confirmationId))
    .orderBy(asc(mcpConfirmationParameters.sortOrder), asc(mcpConfirmationParameters.label));

  return {
    id: row.id,
    userId: row.userId,
    toolName: row.toolName,
    riskTier: row.riskTier as McpConfirmationRiskTier,
    parameters,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

/**
 * AC-3's comparison. Order-insensitive on purpose — a card that lists price before date binds the
 * same agreement — but every label must be present exactly once with exactly the same value. A
 * missing parameter, an added one or a changed value all make the binding stale.
 */
export function bindingMatches(record: McpConfirmationRecord, current: McpBoundParameter[]): boolean {
  if (record.parameters.length !== current.length) return false;
  const bound = new Map(record.parameters.map((parameter) => [parameter.label, parameter.value]));
  if (bound.size !== record.parameters.length) return false;
  for (const parameter of current) {
    if (!bound.has(parameter.label)) return false;
    if (bound.get(parameter.label) !== parameter.value) return false;
  }
  return true;
}

/**
 * The full check the pipeline's step 6 makes: exists, belongs to this user, is for THIS tool, has
 * not expired, has not already been used, and still binds the parameters of the call being made.
 */
export async function resolveMcpConfirmation(input: {
  confirmationId: string;
  userId: string;
  toolName: string;
  parameters: McpBoundParameter[];
  now?: Date;
}): Promise<McpConfirmationResolution> {
  const record = await readMcpConfirmation(input.confirmationId, input.userId);
  if (!record) return { ok: false, rejection: 'not_found' };
  if (record.toolName !== input.toolName) return { ok: false, rejection: 'tool_mismatch' };
  if (record.consumedAt !== null) return { ok: false, rejection: 'consumed' };
  if (record.expiresAt.getTime() <= (input.now ?? new Date()).getTime()) return { ok: false, rejection: 'expired' };
  if (!bindingMatches(record, input.parameters)) return { ok: false, rejection: 'parameters_changed' };
  return { ok: true, record };
}

/**
 * Marks a binding used, so one approval authorises exactly one execution. Returns false if it was
 * already consumed — the caller must then treat the call as unconfirmed rather than run it twice.
 */
export async function consumeMcpConfirmation(confirmationId: string, userId: string, now = new Date()): Promise<boolean> {
  const rows = await getDb()
    .update(mcpConfirmations)
    .set({ consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(mcpConfirmations.id, confirmationId),
        eq(mcpConfirmations.userId, userId),
        // A concurrent second execution finds `consumed_at` already set and updates nothing.
        isNull(mcpConfirmations.consumedAt),
      ),
    )
    .returning({ id: mcpConfirmations.id });
  return rows.length > 0;
}
