import { describe, expect, it } from 'vitest';
import {
  assertAccountMayTransact,
  assertProviderMayTransact,
  getAccountStanding,
  getProviderStanding,
  isSessionBlockingStanding,
  standingError,
  standingToLifecycle,
} from './standing';

/** A fake executor returning one canned row — the standing module's only dependency. */
function executorReturning(rows: unknown[]) {
  return { execute: async () => ({ rows }) } as never;
}

describe('account standing (spec 038 §3.5)', () => {
  it('a sanction value on the account column is the standing', async () => {
    for (const status of ['restricted', 'suspended', 'banned'] as const) {
      expect(await getAccountStanding(executorReturning([{ lifecycle_status: status, active_standing: null }]), 'u')).toBe(status);
    }
  });

  it('OQ-2: while deletion_pending the active sanction still applies, so requesting deletion lifts nothing', async () => {
    expect(await getAccountStanding(executorReturning([{ lifecycle_status: 'deletion_pending', active_standing: 'banned' }]), 'u')).toBe('banned');
    expect(await getAccountStanding(executorReturning([{ lifecycle_status: 'deletion_pending', active_standing: null }]), 'u')).toBe('good');
  });

  it('active, deleted and unknown accounts are in good standing', async () => {
    expect(await getAccountStanding(executorReturning([{ lifecycle_status: 'active', active_standing: null }]), 'u')).toBe('good');
    expect(await getAccountStanding(executorReturning([{ lifecycle_status: 'deleted', active_standing: null }]), 'u')).toBe('good');
    expect(await getAccountStanding(executorReturning([]), 'u')).toBe('good');
  });

  it('provider standing reads only the sanction values of the profile column', async () => {
    expect(await getProviderStanding(executorReturning([{ lifecycle_status: 'suspended' }]), 'p')).toBe('suspended');
    expect(await getProviderStanding(executorReturning([{ lifecycle_status: 'paused' }]), 'p')).toBe('good');
    expect(await getProviderStanding(executorReturning([]), 'p')).toBe('good');
  });

  it('maps standing back to a lifecycle value (good → active) for spec 008 X-6', () => {
    expect(standingToLifecycle('good')).toBe('active');
    expect(standingToLifecycle('banned')).toBe('banned');
  });

  it('only suspended and banned block sessions; restricted does not', () => {
    expect(isSessionBlockingStanding('suspended')).toBe(true);
    expect(isSessionBlockingStanding('banned')).toBe(true);
    expect(isSessionBlockingStanding('restricted')).toBe(false);
    expect(isSessionBlockingStanding('good')).toBe(false);
  });

  it('raises the spec-exact 403 codes', async () => {
    expect(standingError('restricted')).toMatchObject({ code: 'ACCOUNT_RESTRICTED', status: 403 });
    expect(standingError('suspended')).toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
    expect(standingError('banned')).toMatchObject({ code: 'ACCOUNT_BANNED', status: 403 });
    await expect(assertAccountMayTransact(executorReturning([{ lifecycle_status: 'restricted', active_standing: null }]), 'u')).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    await expect(assertAccountMayTransact(executorReturning([{ lifecycle_status: 'active', active_standing: null }]), 'u')).resolves.toBeUndefined();
    await expect(assertProviderMayTransact(executorReturning([{ lifecycle_status: 'banned' }]), 'p')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_IN_GOOD_STANDING',
      status: 403,
      details: { standing: 'banned' },
    });
    await expect(assertProviderMayTransact(executorReturning([{ lifecycle_status: 'active' }]), 'p')).resolves.toBeUndefined();
  });
});
