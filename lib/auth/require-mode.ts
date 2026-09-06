import { forbiddenError } from '@/lib/api/errors';
import type { ActiveMode } from '@/lib/types/users';
import type { SessionRow } from './session';

/**
 * Spec 006 AC-3 — the mode/ownership authorization mechanism this spec establishes for every
 * later mode-scoped endpoint (spec 007 onward) to call before performing a provider-only or
 * customer-only action: `403 FORBIDDEN` when the current session isn't in the required mode,
 * regardless of what the frontend displayed. Concrete provider-only/customer-only actions (e.g.
 * accepting a request) are implemented by their owning domain spec, not here — this spec only
 * defines the check and its `403` contract (spec 006 §7).
 *
 * Ownership (does this user's `CustomerProfile`/`ProviderProfile` own the resource being acted
 * on) is a separate, resource-specific check each owning spec still has to add on top of this —
 * this function only enforces "the current session is in the right mode."
 */
export function requireActiveMode(session: Pick<SessionRow, 'activeMode'>, mode: ActiveMode): void {
  if (session.activeMode !== mode) {
    throw forbiddenError(`This action requires ${mode} mode.`);
  }
}
