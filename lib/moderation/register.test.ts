import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  restrictFromSafetyReport: vi.fn(),
  restrictionModuleLoaded: vi.fn(),
  registerModerationEvidenceContext: vi.fn(),
}));

vi.mock('./restriction-gate', () => {
  mocks.restrictionModuleLoaded();
  return { restrictFromSafetyReport: mocks.restrictFromSafetyReport };
});
vi.mock('./evidence-policy', () => ({ registerModerationEvidenceContext: mocks.registerModerationEvidenceContext }));

import { getPayoutHoldGate } from '@/lib/payouts/ports';
import { getSafetyRestrictionGate, type RestrictionRequest } from '@/lib/safety/restriction-gate';
import { moderationPayoutHoldGate } from './payout-hold';
import { lazySafetyRestrictionGate, registerModerationIntegration, resetModerationIntegration } from './register';

const REQUEST: RestrictionRequest = {
  safetyReportId: 'r1',
  targetUserId: 'u1',
  requestedByAdminUserId: 'a1',
  reason: 'Repeated harassment reports.',
  correlationId: null,
};

const ROOT = join(__dirname, '..', '..');
const code = (file: string) =>
  readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('spec 038 — lightweight composition-root registration', () => {
  afterEach(() => {
    resetModerationIntegration();
    vi.clearAllMocks();
  });

  it('registers all three ports: the restriction gate, the payout-hold gate and the evidence context', () => {
    registerModerationIntegration();
    expect(getSafetyRestrictionGate()).toBe(lazySafetyRestrictionGate);
    expect(getPayoutHoldGate()).toBe(moderationPayoutHoldGate);
    expect(mocks.registerModerationEvidenceContext).toHaveBeenCalledTimes(1);
  });

  it('registering loads no moderation action engine; the restriction gate loads it on first use and delegates exactly', async () => {
    registerModerationIntegration();
    expect(mocks.restrictionModuleLoaded).not.toHaveBeenCalled();

    mocks.restrictFromSafetyReport.mockResolvedValue({ moderationActionId: 'm1' });
    await expect(getSafetyRestrictionGate()(REQUEST)).resolves.toEqual({ moderationActionId: 'm1' });
    expect(mocks.restrictionModuleLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.restrictFromSafetyReport).toHaveBeenCalledWith(REQUEST);
  });

  it("a refusal from the real gate propagates unchanged (spec 030 must fail its transaction, never swallow it)", async () => {
    registerModerationIntegration();
    const refusal = Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
    mocks.restrictFromSafetyReport.mockRejectedValue(refusal);
    await expect(getSafetyRestrictionGate()(REQUEST)).rejects.toBe(refusal);
  });

  it('reset returns spec 030 and spec 024 ports to their documented defaults', async () => {
    registerModerationIntegration();
    resetModerationIntegration();
    await expect(getSafetyRestrictionGate()(REQUEST)).rejects.toMatchObject({ code: 'RESTRICTION_UNAVAILABLE' });
    await expect(getPayoutHoldGate()({} as never, 'p1')).resolves.toEqual({ held: false });
  });

  it('instrumentation.ts imports the lightweight module, and it never statically imports the action engine', () => {
    const instrumentation = code('instrumentation.ts');
    expect(instrumentation).toMatch(/import\(['"]@\/lib\/moderation\/register['"]\)/);
    expect(instrumentation).not.toMatch(/import\(['"]@\/lib\/moderation['"]\)/);

    const register = code('lib/moderation/register.ts');
    expect(register).not.toMatch(/from ['"]\.\/(actions|restriction-gate|appeals|fraud-signals|rules|read|validation)['"]/);
    expect(register).not.toMatch(/from ['"]\.\/index['"]|from ['"]@\/lib\/moderation['"]/);
  });
});
