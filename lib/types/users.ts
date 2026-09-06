/** Spec 006 §3 request/response types. */
export type ActiveMode = 'customer' | 'provider';

export function isActiveMode(value: unknown): value is ActiveMode {
  return value === 'customer' || value === 'provider';
}

export interface UserDto {
  id: string;
  hasCustomerProfile: boolean;
  hasProviderProfile: boolean;
  /**
   * Active mode of the CURRENT session (backed by `Session.active_mode`, spec 006 §4) — not a
   * global user preference. The same user authenticated on another device/session may be in a
   * different mode; that's intentional (spec 006 §8, resolved).
   */
  activeMode: ActiveMode;
  /**
   * Included so the frontend can gate admin-only UI (e.g. the admin console entry point, spec
   * 009) from this single `/users/me` call instead of a second round-trip. Read-only here; admin
   * status is provisioned out-of-band (spec 006 §7), never set via this API.
   */
  isAdmin: boolean;
}

export interface ProviderProfileDto {
  id: string;
  userId: string;
  businessName: string | null;
  lifecycleStatus: string;
}

export interface SwitchModeRequest {
  mode: ActiveMode;
}
