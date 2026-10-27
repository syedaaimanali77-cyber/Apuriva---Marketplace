/**
 * Account → Profile — `GET/PATCH /api/v1/users/me/profile` and `GET/PATCH /api/v1/providers/me/profile`.
 *
 * Only fields that already exist in the data model: the customer's display name, the provider's business
 * name, and the account's email and phone shown read-only with their verified state (changing them needs
 * spec 005's verification flows, which do not exist).
 */
export interface UserProfileDto {
  /** `null` = not set. Shown to counterparties in messaging and booking lists. */
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneVerified: boolean;
  /** Optimistic-concurrency token for the display name; send it back as `expectedVersion`. */
  version: number;
}

export interface UpdateUserProfileRequest {
  /** A string to set (trimmed; empty clears it) or `null` to clear. */
  displayName: string | null;
  expectedVersion: number;
}

export interface ProviderProfileDto {
  /** `null` = not set. Published immediately; spec 038 moderates provider profiles after publication. */
  businessName: string | null;
  version: number;
}

export interface UpdateProviderProfileRequest {
  businessName: string | null;
  expectedVersion: number;
}
