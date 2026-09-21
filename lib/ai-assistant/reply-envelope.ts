/**
 * Spec 034 §3.3 "Reply envelope" — parses the `conversation` task's output.
 *
 * The contract is the JSON object `{ "reply": string, "memoryProposal"?: { "key", "value" } }`.
 *
 * - An output that is not such an object is treated ENTIRELY as the reply, with no proposal. Spec
 *   033's sandbox adapter returns a plain marked placeholder, so until a real provider's prompt
 *   template emits this envelope (§8 risk 9) Ask Apuriva proposes no memory — failing closed.
 * - A proposal whose key is not allow-listed, or whose value fails that key's SHAPE, is dropped
 *   silently and the reply is still returned (AC-13). The model can never widen what memory holds.
 *   (The catalogue rule — a published category — is checked by the caller, which has the database.)
 *
 * Pure: no I/O, so it is the same function for normal and temporary turns.
 */
import type { AiMemoryEntry } from '@/lib/types/ai-assistant';
import { validateMemoryShape } from './memory-keys';

export interface ParsedReply {
  reply: string;
  memoryProposal: AiMemoryEntry | null;
}

export function parseReplyEnvelope(output: string): ParsedReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { reply: output, memoryProposal: null };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { reply: output, memoryProposal: null };
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope.reply !== 'string') return { reply: output, memoryProposal: null };

  const candidate = envelope.memoryProposal;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { reply: envelope.reply, memoryProposal: null };
  }
  const { key, value } = candidate as Record<string, unknown>;
  const shape = validateMemoryShape(key, value);
  return { reply: envelope.reply, memoryProposal: shape.ok ? shape.entry : null };
}
