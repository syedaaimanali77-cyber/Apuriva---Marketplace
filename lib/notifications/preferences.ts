/**
 * Spec 026 §3 "Preference resolution" and "Marketing consent" (AC-1, AC-2, AC-3).
 *
 * ONE resolution function, consulted once per event (and re-consulted when a queued delivery is
 * dispatched, so a later opt-out is honoured):
 *   1. `promotions` → consent AND the `promotions` preference (AND the cap, checked by `notify`).
 *   2. non-overridable → the category's floor channels (the defaults' `true` channels — email) are
 *      always on, plus any channel the user additionally switched on. A stored `false` on a floor
 *      channel is unreachable through the API and ignored here.
 *   3. otherwise → the stored per-category map decides.
 *   4. no row → `NOTIFICATION_DEFAULTS`.
 * In-app is never part of this: a disabled category suppresses OUTBOUND channels only.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { validationError } from '@/lib/api/errors';
import {
  CRITICAL_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  OUTBOUND_CHANNELS,
  isCriticalCategory,
  type CategoryChannelMap,
  type CategoryChannelPatch,
  type MarketingConsentDto,
  type NotificationCategory,
  type NotificationPreferencesDto,
  type OutboundChannel,
} from '@/lib/types/notifications';
import { NOTIFICATION_DEFAULTS, defaultCategoryChannelMap } from './defaults';
import { categoryNotOverridableError, preferencesVersionConflictError } from './errors';
import { queryRows, type Executor } from './sql';

export interface StoredPreferences {
  categories: CategoryChannelMap;
  marketingConsentAt: Date | null;
  version: number;
}

type FieldError = { field: string; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Write-time validation of a (partial) category → channel map. Unknown categories or channels, a
 * non-boolean value, or a malformed shape are reported per field — `400 VALIDATION_ERROR`. `in_app`
 * is rejected as a key: it is never optional, so it has no toggle.
 */
export function validateCategoryChannelMap(input: unknown, options: { partial: boolean }): FieldError[] {
  if (!isPlainObject(input)) return [{ field: 'categories', message: 'must be an object' }];
  const errors: FieldError[] = [];
  for (const [category, channels] of Object.entries(input)) {
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) {
      errors.push({ field: `categories.${category}`, message: 'is not a notification category' });
      continue;
    }
    if (!isPlainObject(channels)) {
      errors.push({ field: `categories.${category}`, message: 'must be an object of channel booleans' });
      continue;
    }
    for (const [channel, enabled] of Object.entries(channels)) {
      if (!(OUTBOUND_CHANNELS as readonly string[]).includes(channel)) {
        errors.push({ field: `categories.${category}.${channel}`, message: 'is not a configurable channel' });
      } else if (typeof enabled !== 'boolean') {
        errors.push({ field: `categories.${category}.${channel}`, message: 'must be a boolean' });
      }
    }
    if (!options.partial) {
      for (const channel of OUTBOUND_CHANNELS) {
        if (typeof channels[channel] !== 'boolean') {
          errors.push({ field: `categories.${category}.${channel}`, message: 'is required' });
        }
      }
    }
  }
  if (!options.partial) {
    for (const category of NOTIFICATION_CATEGORIES) {
      if (!(category in input)) errors.push({ field: `categories.${category}`, message: 'is required' });
    }
  }
  return errors;
}

/** Reads a stored map defensively: anything missing or malformed falls back to the default. */
export function normalizeCategoryChannelMap(stored: unknown): CategoryChannelMap {
  const result = defaultCategoryChannelMap();
  if (!isPlainObject(stored)) return result;
  for (const category of NOTIFICATION_CATEGORIES) {
    const channels = stored[category];
    if (!isPlainObject(channels)) continue;
    for (const channel of OUTBOUND_CHANNELS) {
      if (typeof channels[channel] === 'boolean') result[category][channel] = channels[channel] as boolean;
    }
  }
  return result;
}

/** A floor channel: on in the defaults for a non-overridable category, so it can never be switched off. */
export function isFloorChannel(category: NotificationCategory, channel: OutboundChannel): boolean {
  return isCriticalCategory(category) && NOTIFICATION_DEFAULTS[category][channel];
}

/** Steps 2–4 for one category. Pure. `promotions` consent is layered on top by `promotionsAllowed`. */
export function resolveOutboundChannels(
  category: NotificationCategory,
  stored: CategoryChannelMap | null,
): OutboundChannel[] {
  const map = stored ?? NOTIFICATION_DEFAULTS;
  return OUTBOUND_CHANNELS.filter((channel) => map[category][channel] || isFloorChannel(category, channel));
}

/** Step 1 without the cap: consent AND at least one enabled `promotions` channel. Pure. */
export function promotionsAllowed(prefs: StoredPreferences | null): { allowed: true } | { allowed: false; reason: 'no_consent' | 'preference_disabled' } {
  if (!prefs || prefs.marketingConsentAt === null) return { allowed: false, reason: 'no_consent' };
  if (resolveOutboundChannels('promotions', prefs.categories).length === 0) {
    return { allowed: false, reason: 'preference_disabled' };
  }
  return { allowed: true };
}

export async function loadStoredPreferences(db: Executor, userId: string): Promise<StoredPreferences | null> {
  const [row] = await queryRows<{ categories: unknown; marketing_consent_at: Date | null; version: number }>(
    db,
    sql`SELECT categories, marketing_consent_at, version FROM notification_preferences WHERE user_id = ${userId}`,
  );
  if (!row) return null;
  return {
    categories: normalizeCategoryChannelMap(row.categories),
    marketingConsentAt: row.marketing_consent_at ? new Date(row.marketing_consent_at) : null,
    version: row.version,
  };
}

function toDto(prefs: StoredPreferences | null): NotificationPreferencesDto {
  const categories = prefs ? prefs.categories : defaultCategoryChannelMap();
  // The DTO shows the RESOLVED map: a floor channel always reads as on.
  for (const category of CRITICAL_CATEGORIES) {
    for (const channel of OUTBOUND_CHANNELS) {
      if (isFloorChannel(category, channel)) categories[category][channel] = true;
    }
  }
  return {
    categories,
    nonOverridableCategories: [...CRITICAL_CATEGORIES],
    marketingConsentAt: prefs?.marketingConsentAt ? prefs.marketingConsentAt.toISOString() : null,
    version: prefs?.version ?? 0,
  };
}

/** `GET /users/me/notification-preferences` — resolved defaults when no row exists. */
export async function getNotificationPreferences(userId: string): Promise<NotificationPreferencesDto> {
  return toDto(await loadStoredPreferences(getDb(), userId));
}

/**
 * `PATCH /users/me/notification-preferences`. Validation first (400), then the non-overridable rule
 * (422, nothing changed), then optimistic concurrency on `version` (409). The row is created lazily on
 * the first write; `version: 0` is what a caller sends before one exists.
 */
export async function updateNotificationPreferences(userId: string, body: unknown): Promise<NotificationPreferencesDto> {
  const input = isPlainObject(body) ? body : {};
  const errors = validateCategoryChannelMap(input.categories, { partial: true });
  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 0) {
    errors.push({ field: 'version', message: 'must be a non-negative integer' });
  }
  if (errors.length > 0) throw validationError(errors);

  const patch = input.categories as CategoryChannelPatch;
  const expectedVersion = input.version as number;

  for (const category of NOTIFICATION_CATEGORIES) {
    const channels = patch[category];
    if (!channels) continue;
    for (const channel of OUTBOUND_CHANNELS) {
      if (channels[channel] === false && isFloorChannel(category, channel)) throw categoryNotOverridableError(category);
    }
  }

  const db = getDb();
  return db.transaction(async (tx) => {
    const current = await loadStoredPreferences(tx, userId);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) throw preferencesVersionConflictError(currentVersion);

    const next = current ? current.categories : defaultCategoryChannelMap();
    for (const category of NOTIFICATION_CATEGORIES) {
      const channels = patch[category];
      if (!channels) continue;
      for (const channel of OUTBOUND_CHANNELS) {
        if (typeof channels[channel] === 'boolean') next[category][channel] = channels[channel] as boolean;
      }
    }
    const json = JSON.stringify(next);

    const written = current
      ? await queryRows<{ version: number }>(
          tx,
          sql`UPDATE notification_preferences
                 SET categories = ${json}::jsonb, version = version + 1, updated_at = clock_timestamp()
               WHERE user_id = ${userId} AND version = ${expectedVersion}
           RETURNING version`,
        )
      : await queryRows<{ version: number }>(
          tx,
          sql`INSERT INTO notification_preferences (user_id, categories)
              VALUES (${userId}, ${json}::jsonb)
              ON CONFLICT (user_id) DO NOTHING
           RETURNING version`,
        );
    if (written.length === 0) {
      const raced = await loadStoredPreferences(tx, userId);
      throw preferencesVersionConflictError(raced?.version ?? 0);
    }

    console.log(JSON.stringify({ event: 'notification.preferences_updated', userId }));
    return toDto(await loadStoredPreferences(tx, userId));
  });
}

export const MARKETING_CONSENT_SOURCE = 'account_settings';

/**
 * `POST /users/me/marketing-consent` (AC-3). Idempotent: granting while consented keeps the ORIGINAL
 * instant; withdrawing while not consented is a no-op. Every real change appends a compliance record to
 * `security_events`, so consent HISTORY survives although the column holds only the current state.
 * Withdrawal takes effect on the next resolution — including a promotional delivery already queued.
 */
export async function setMarketingConsent(userId: string, body: unknown): Promise<MarketingConsentDto> {
  const input = isPlainObject(body) ? body : {};
  if (typeof input.consent !== 'boolean') throw validationError([{ field: 'consent', message: 'must be a boolean' }]);
  const consent = input.consent;

  const db = getDb();
  const outcome = await db.transaction(async (tx) => {
    // Lazily create the row so consent has somewhere to live; the defaults are the stored map.
    await tx.execute(sql`
      INSERT INTO notification_preferences (user_id, categories)
      VALUES (${userId}, ${JSON.stringify(defaultCategoryChannelMap())}::jsonb)
      ON CONFLICT (user_id) DO NOTHING
    `);
    const [row] = await queryRows<{ marketing_consent_at: Date | null }>(
      tx,
      sql`SELECT marketing_consent_at FROM notification_preferences WHERE user_id = ${userId} FOR UPDATE`,
    );
    const had = row?.marketing_consent_at ?? null;
    if (consent === (had !== null)) return { changed: false, at: had };

    const [updated] = await queryRows<{ marketing_consent_at: Date | null }>(
      tx,
      consent
        ? sql`UPDATE notification_preferences
                 SET marketing_consent_at = clock_timestamp(), marketing_consent_source = ${MARKETING_CONSENT_SOURCE},
                     version = version + 1, updated_at = clock_timestamp()
               WHERE user_id = ${userId} RETURNING marketing_consent_at`
        : sql`UPDATE notification_preferences
                 SET marketing_consent_at = NULL, marketing_consent_source = NULL,
                     version = version + 1, updated_at = clock_timestamp()
               WHERE user_id = ${userId} RETURNING marketing_consent_at`,
    );
    return { changed: true, at: updated?.marketing_consent_at ?? null };
  });

  if (outcome.changed) {
    await recordSecurityEvent({
      userId,
      eventType: consent ? 'notifications.marketing_consent_granted' : 'notifications.marketing_consent_withdrawn',
      severity: 'info',
      metadata: { source: MARKETING_CONSENT_SOURCE },
    });
    console.log(JSON.stringify({ event: 'notification.consent_changed', userId, consent }));
  }
  return { marketingConsentAt: outcome.at ? new Date(outcome.at).toISOString() : null };
}
