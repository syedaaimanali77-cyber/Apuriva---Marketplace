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
  /**
   * Spec 042 §3.11 (X-4, AC-7) — additive: the SAVED UI locale (`users.locale`), `null` when the user has
   * never chosen one. It is the preference as stored, not the resolved locale (see `PATCH /users/me/locale`).
   */
  locale: string | null;
  /**
   * Spec 045 X-7 — additive: `users.is_demo`, so the account page can offer "Reset demo" (X-4) to a demo
   * user only. Never an authorization input: `POST /api/v1/demo/reset` re-reads the column itself.
   * Set by both routes that build this DTO — `GET /users/me` and `PATCH /users/me/active-mode` — exactly as spec
   * 042 X-4 added `locale`, so a mode switch (which replaces the client's copy) never drops it.
   */
  isDemo: boolean;
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
