/**
 * Spec 033 §3.3 — the ONLY vendor-facing interface in this repository.
 *
 * `lib/ai/provider/` is the only directory permitted to import a vendor SDK or read an AI
 * credential (`AI_*_KEY` / `AI_*_SECRET` / `AI_*_TOKEN`); `lib/ai/boundary.test.ts` fails if any
 * other module does either, or references this interface at all (AC-1).
 */
import type { AiTask } from '../types';

export interface AiProviderCompletion {
  output: string;
  tokensUsed: number;
}

export interface AiProviderAdapter {
  /** Stable internal identifier, e.g. 'sandbox'. Recorded in usage, never returned to a caller. */
  readonly name: string;
  /** The model this adapter is configured to use, recorded alongside `name`. */
  readonly model: string;
  /** True for any adapter that does not reach a real provider. `resolveAiProvider` refuses these
   * under NODE_ENV=production (AC-2), the same guard as lib/notifications/channels/index.ts. */
  readonly isSandbox: boolean;
  /** The prompt template version this adapter implements. Part of the cache key, so a prompt
   * change can never be answered from a cache built by the previous prompt. */
  readonly promptVersion: string;
  complete(input: { task: AiTask; input: string; maxTokens: number }): Promise<AiProviderCompletion>;
}
