/** Spec 034 §3.5 — master spec §87's tiers mapped to §90's confirmation levels (AC-4 – AC-7). */
import { describe, expect, it } from 'vitest';
import { decideRisk, requiresConfirmation, type AiProposedRiskTier } from './risk-policy';

describe('risk policy (§3.5)', () => {
  it('low risk executes immediately, with no confirmation (AC-4)', () => {
    expect(decideRisk('low')).toEqual({ kind: 'execute' });
    expect(requiresConfirmation('low')).toBe(false);
  });

  it('medium risk needs an explicit confirmation (AC-5)', () => {
    expect(decideRisk('medium')).toEqual({ kind: 'confirm', tier: 'medium' });
    expect(requiresConfirmation('medium')).toBe(true);
  });

  it('high risk needs the structured confirmation (AC-6)', () => {
    expect(decideRisk('high')).toEqual({ kind: 'confirm', tier: 'high' });
    expect(requiresConfirmation('high')).toBe(true);
  });

  it('restricted is refused before the executor — never executed, never confirmable (AC-7)', () => {
    expect(decideRisk('restricted')).toEqual({ kind: 'refuse' });
    expect(requiresConfirmation('restricted')).toBe(false);
  });

  it('an unknown tier from a misbehaving executor is refused, never executed', () => {
    expect(decideRisk('critical' as AiProposedRiskTier)).toEqual({ kind: 'refuse' });
  });

  it('defines exactly the four master spec §87 tiers and no others', () => {
    const tiers: AiProposedRiskTier[] = ['low', 'medium', 'high', 'restricted'];
    expect(tiers.map((t) => decideRisk(t).kind)).toEqual(['execute', 'confirm', 'confirm', 'refuse']);
  });
});
