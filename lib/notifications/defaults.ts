/**
 * Spec 026 §3 "Preference resolution" step 4 — what a user who never opened settings receives.
 *
 * In-app is on for everything (it is not in this map because it is never optional). Email is on for the
 * non-overridable categories, so §57's security/payments/operational notices reach the user by default;
 * push and sms are off everywhere, and so is every outbound channel for the overridable categories.
 */
import {
  NOTIFICATION_CATEGORIES,
  isCriticalCategory,
  type CategoryChannelMap,
  type ChannelToggles,
} from '@/lib/types/notifications';

function defaultsFor(critical: boolean): ChannelToggles {
  return { email: critical, push: false, sms: false };
}

export const NOTIFICATION_DEFAULTS: Readonly<CategoryChannelMap> = Object.freeze(
  Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, Object.freeze(defaultsFor(isCriticalCategory(category)))]),
  ) as CategoryChannelMap,
);

/** A fresh, mutable copy — never hand out the frozen constant for editing. */
export function defaultCategoryChannelMap(): CategoryChannelMap {
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, { ...NOTIFICATION_DEFAULTS[category] }]),
  ) as CategoryChannelMap;
}
