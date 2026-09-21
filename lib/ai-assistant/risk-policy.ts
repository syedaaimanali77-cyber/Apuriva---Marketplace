/**
 * Spec 034 §3.5 — master spec §87's four tiers mapped to master spec §90's confirmation levels.
 * This is the ONE place a tier decides what happens, and it runs before the executor is called.
 *
 * | tier       | decision                                                             |
 * |------------|----------------------------------------------------------------------|
 * | low        | execute immediately, no confirmation                                 |
 * | medium     | never executed until an explicit `POST …/confirm` for its id          |
 * | high       | as medium; the UI is the structured, parameter-bound card             |
 * | restricted | refused — never offered, never passed to the executor, never recorded |
 *
 * Confirmation is necessary, never sufficient: a payment still needs spec 021's authorization and
 * an account/security change still needs spec 008's step-up. Those checks live in the domain the
 * executor calls into, not here.
 */
export type AiProposedRiskTier = 'low' | 'medium' | 'high' | 'restricted';

export type AiRiskDecision =
  | { kind: 'execute' }
  | { kind: 'confirm'; tier: 'medium' | 'high' }
  | { kind: 'refuse' };

export function decideRisk(tier: AiProposedRiskTier): AiRiskDecision {
  switch (tier) {
    case 'low':
      return { kind: 'execute' };
    case 'medium':
    case 'high':
      return { kind: 'confirm', tier };
    case 'restricted':
      return { kind: 'refuse' };
    default:
      // An unknown tier from a misbehaving executor is refused, never executed.
      return { kind: 'refuse' };
  }
}

/** Whether an action of this tier may only run after an explicit confirmation request. */
export function requiresConfirmation(tier: AiProposedRiskTier): boolean {
  return decideRisk(tier).kind === 'confirm';
}
