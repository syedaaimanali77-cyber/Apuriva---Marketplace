/**
 * Baseline schema — docs/specs/2026-08-28-003-database-core-data-model.md.
 *
 * Every table here is deliberately minimal: identity (`id`), audit (`created_at`/`updated_at`),
 * optimistic-concurrency (`version`), and structural foreign keys only. Feature-specific columns
 * (an Offer's price, a Booking's schedule, a Payment's amount, ...) are added by each entity's
 * owning spec — this file is the shared foundation they build on, not the finished schema.
 *
 * Conventions encoded below (see docs/specs/2026-08-28-003-database-core-data-model.md §4):
 *   - `id`/`auditColumns`/`version()`/`baseColumns()` — identity/audit/concurrency baseline for
 *     every table.
 *   - `moneyColumns()` + `moneyPairChecks()` — AC-1: minor-units + currency-code pair, never
 *     numeric/float/double, with a DB CHECK tying the pair together. Not used by any table yet
 *     (no baseline table has a real monetary value) — ready for the owning spec that adds one.
 *   - `scheduledTimeColumns()` — AC-2: a timestamptz instant paired with the original IANA
 *     timezone identifier. Not used by any table yet, for the same reason as money.
 *   - `status` column + `*_status_history` + `*_status_transitions` tables (AC-3) for the five
 *     state-machine entities (Request, Offer, Booking, Payment, Payout). The DB trigger that
 *     enforces transitions against the `*_status_transitions` whitelist is appended by hand to
 *     drizzle/0001_baseline_schema's generated SQL — Drizzle's schema DSL has no
 *     function/trigger builder. This spec does not decide or populate any entity's actual
 *     states/transitions; the transition tables start empty.
 *   - Every FK below is `onDelete: 'restrict'` and has its own covering index, per AC-4.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Shared conventions
// ---------------------------------------------------------------------------

/** `id uuid primary key default gen_random_uuid()` */
export const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/** `created_at` / `updated_at timestamptz not null default now()` */
export const auditColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** AC-6 optimistic concurrency: paired with `UPDATE ... WHERE id = $1 AND version = $2`. */
export const version = () => integer('version').notNull().default(1);

/** Every baseline table gets id + audit + version; nothing else, per spec 003 §4. */
export const baseColumns = () => ({
  id: id(),
  ...auditColumns(),
  version: version(),
});

/**
 * AC-1 money convention: call with a semantic base name (e.g. "deposit") to get that value's
 * own `<base>_amount_minor_units integer` + `<base>_currency_code text` pair — never a single
 * `amount`/`currency` pair reused across more than one monetary value on the same row.
 */
export function moneyColumns<Base extends string>(base: Base) {
  return {
    [`${base}AmountMinorUnits`]: integer(`${base}_amount_minor_units`),
    [`${base}CurrencyCode`]: text(`${base}_currency_code`),
  } as Record<`${Base}AmountMinorUnits`, ReturnType<typeof integer>> &
    Record<`${Base}CurrencyCode`, ReturnType<typeof text>>;
}

/**
 * AC-1 DB constraints for a `moneyColumns(base)` pair: both columns null together or set
 * together, and the currency code (when set) is a 3-letter uppercase ISO-4217-shaped code.
 * `tableName` + `base` must match what `moneyColumns` was called with, for the raw SQL
 * identifiers to line up.
 */
export function moneyPairChecks(tableName: string, base: string) {
  const amountCol = `${base}_amount_minor_units`;
  const currencyCol = `${base}_currency_code`;
  return [
    check(
      `${tableName}_${base}_pair_ck`,
      sql`(${sql.raw(`"${amountCol}"`)} is null) = (${sql.raw(`"${currencyCol}"`)} is null)`,
    ),
    check(
      `${tableName}_${base}_currency_format_ck`,
      sql`${sql.raw(`"${currencyCol}"`)} is null or ${sql.raw(`"${currencyCol}"`)} ~ '^[A-Z]{3}$'`,
    ),
  ];
}

/**
 * AC-2 scheduled/appointment-local-time convention: call with a semantic base name (e.g.
 * "scheduled") to get `<base>_at timestamptz` (the instant, UTC) + `<base>_timezone text` (the
 * original IANA identifier, e.g. "Asia/Karachi") so the local wall-clock time is reconstructible
 * regardless of server timezone.
 */
export function scheduledTimeColumns<Base extends string>(base: Base) {
  return {
    [`${base}At`]: timestamp(`${base}_at`, { withTimezone: true }),
    [`${base}Timezone`]: text(`${base}_timezone`),
  } as Record<`${Base}At`, ReturnType<typeof timestamp>> & Record<`${Base}Timezone`, ReturnType<typeof text>>;
}

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

/**
 * Spec 005 §4: extends this spec 003 baseline table with authentication identity columns —
 * no new table. `phone_number`/`email` are nullable+unique (a user may sign up via either path;
 * Postgres UNIQUE allows multiple NULLs, so email-only and phone-only rows coexist).
 */
/** Spec 008 §4, master spec §67: account-level lifecycle, distinct from `ProviderProfile`'s own
 * (a suspended provider profile doesn't necessarily mean the underlying account is suspended). */
export const USER_LIFECYCLE_STATUSES = [
  'active',
  'restricted',
  'suspended',
  'banned',
  'deletion_pending',
  'deleted',
] as const;

export const DATA_EXPORT_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;

export const users = pgTable(
  'users',
  {
    ...baseColumns(),
    phoneNumber: text('phone_number').unique(),
    email: text('email').unique(),
    passwordHash: text('password_hash'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Spec 008 §4/AC-4. */
    lifecycleStatus: text('lifecycle_status', { enum: USER_LIFECYCLE_STATUSES }).notNull().default('active'),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    deletionGraceEndsAt: timestamp('deletion_grace_ends_at', { withTimezone: true }),
    /** Spec 008 §3 `GET/POST .../data-export`: the single in-flight-or-most-recent export request
     * for this account — one active export at a time (repeat requests while non-terminal return
     * this same id, AC-3/idempotency). Unique so a download link unambiguously resolves one user. */
    dataExportRequestId: uuid('data_export_request_id'),
    dataExportStatus: text('data_export_status', { enum: DATA_EXPORT_STATUSES }),
    dataExportFileAssetId: uuid('data_export_file_asset_id').references((): AnyPgColumn => fileAssets.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('users_data_export_file_asset_id_idx').on(t.dataExportFileAssetId),
    uniqueIndex('users_data_export_request_id_uq').on(t.dataExportRequestId),
    check('users_lifecycle_status_ck', sql`${t.lifecycleStatus} in ('active','restricted','suspended','banned','deletion_pending','deleted')`),
    check('users_data_export_status_ck', sql`${t.dataExportStatus} is null or ${t.dataExportStatus} in ('pending','processing','ready','failed')`),
  ],
);

export const customerProfiles = pgTable(
  'customer_profiles',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Spec 014 §4/§7 AC-7: opt out of home-feed personalization. Stops using history for
     * recommendations (falls back to `curated_popular`); does not itself delete the underlying
     * history — deletion is spec 008's separate, explicit flow. */
    personalizationEnabled: boolean('personalization_enabled').notNull().default(true),
  },
  (t) => [index('customer_profiles_user_id_idx').on(t.userId)],
);

/** Spec 006 §4 (Entities table), master spec §66. */
export const PROVIDER_PROFILE_LIFECYCLE_STATUSES = [
  'draft',
  'pending_verification',
  'active',
  'paused',
  'restricted',
  'suspended',
  'banned',
] as const;

export const providerProfiles = pgTable(
  'provider_profiles',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Spec 006 §4. */
    businessName: text('business_name'),
    /** Spec 006 §4/retention: transitions (e.g. Suspended, Banned) are audited (spec 039). */
    lifecycleStatus: text('lifecycle_status', { enum: PROVIDER_PROFILE_LIFECYCLE_STATUSES }).notNull().default('draft'),
    /**
     * Spec 016 §3 R1: ONE IANA scheduling timezone per provider — never per availability row.
     * Every weekly entry and date override is a local wall-clock value in this zone, so
     * converting them to a UTC instant follows that zone's DST rules by construction. Not a
     * `scheduledTimeColumns()` pair (spec 003 AC-2): a recurring weekly schedule is not an
     * instant, so there is no timestamptz to pair the identifier with.
     */
    schedulingTimezone: text('scheduling_timezone').notNull().default('Asia/Karachi'),
  },
  (t) => [
    index('provider_profiles_user_id_idx').on(t.userId),
    check('provider_profiles_lifecycle_status_ck', sql`${t.lifecycleStatus} in ('draft','pending_verification','active','paused','restricted','suspended','banned')`),
  ],
);

/** Spec 005 §4/§8 risk #2: adds admin TOTP-MFA columns to this spec 003 baseline table. */
export const adminProfiles = pgTable(
  'admin_profiles',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    // AES-256-GCM ciphertext (lib/auth/totp-secret-crypto.ts) — the raw TOTP secret is never
    // stored in plaintext.
    totpSecretEncrypted: text('totp_secret_encrypted'),
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
  },
  (t) => [index('admin_profiles_user_id_idx').on(t.userId)],
);

/** Spec 009 §4.1, master spec §69: the seven canonical admin roles — seeded exactly once
 * (drizzle/0005_add_spec_009_admin_rbac.sql), never created ad hoc by application code. */
export const ADMIN_ROLES = [
  'super_admin',
  'operations_admin',
  'support_admin',
  'finance_admin',
  'trust_safety_admin',
  'content_admin',
  'analytics_admin',
] as const;

export const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;

export const roles = pgTable(
  'roles',
  {
    ...baseColumns(),
    name: text('name', { enum: ADMIN_ROLES }).notNull().unique(),
  },
  (t) => [check('roles_name_ck', sql`${t.name} in ('super_admin','operations_admin','support_admin','finance_admin','trust_safety_admin','content_admin','analytics_admin')`)],
);

/** Spec 009 §4/§4.3: a role's `(resource, action)` grant and the risk tier that action carries.
 * Deliberately starts empty — each domain spec (022 refunds, 038 moderation, ...) owns and inserts
 * its own rows here; this spec owns only the shape and the resolution contract (§3.1) that reads
 * it, never an exhaustive business mapping. */
export const permissions = pgTable(
  'permissions',
  {
    ...baseColumns(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    riskTier: text('risk_tier', { enum: RISK_TIERS }).notNull(),
  },
  (t) => [
    index('permissions_role_id_idx').on(t.roleId),
    uniqueIndex('permissions_role_resource_action_uq').on(t.roleId, t.resource, t.action),
    check('permissions_risk_tier_ck', sql`${t.riskTier} in ('low','medium','high','critical')`),
  ],
);

/** Spec 009 §4: many-to-many — "an admin account is assigned one or more of the seven roles"
 * (master spec §69). Not itself in master spec §124's minimum entity list; added because §69's
 * requirement has no other structural home. */
export const adminRoleAssignments = pgTable(
  'admin_role_assignments',
  {
    ...baseColumns(),
    adminProfileId: uuid('admin_profile_id')
      .notNull()
      .references(() => adminProfiles.id, { onDelete: 'restrict' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('admin_role_assignments_admin_profile_id_idx').on(t.adminProfileId),
    index('admin_role_assignments_role_id_idx').on(t.roleId),
    uniqueIndex('admin_role_assignments_admin_profile_role_uq').on(t.adminProfileId, t.roleId),
  ],
);

/** Spec 009 §4/§4.1/§4.2: the risk-tiered approval workflow record. Only ever created for a
 * `high`/`critical` action (§3.1) — a `low`/`medium` action proceeds without one. Not in master
 * spec §124's minimum entity list; spec 009 (§69/§70) is the entity's sole owner. */
export const ADMIN_ACTION_STATUSES = [
  'Pending',
  'Approved',
  'Rejected',
  'Executed',
  'PostActionReviewRequired',
  'PostActionReviewed',
] as const;

export const adminActions = pgTable(
  'admin_actions',
  {
    ...baseColumns(),
    /** The initiating admin. */
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminProfiles.id, { onDelete: 'restrict' }),
    resource: text('resource').notNull(),
    actionType: text('action_type').notNull(),
    riskTier: text('risk_tier', { enum: ['high', 'critical'] as const }).notNull(),
    status: text('status', { enum: ADMIN_ACTION_STATUSES }).notNull().default('Pending'),
    reason: text('reason').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    /** §3.2: set only for an action created via the emergency-bypass path. */
    isEmergencyBypass: boolean('is_emergency_bypass').notNull().default(false),
    /** §3.2/AC-3: mandatory post-action review outcome for an emergency-bypass action — null until
     * `PostActionReviewRequired` transitions to `PostActionReviewed`. */
    postActionReviewByAdminId: uuid('post_action_review_by_admin_id').references(() => adminProfiles.id, { onDelete: 'restrict' }),
    postActionReviewedAt: timestamp('post_action_reviewed_at', { withTimezone: true }),
    postActionReviewNotes: text('post_action_review_notes'),
  },
  (t) => [
    index('admin_actions_admin_id_idx').on(t.adminId),
    index('admin_actions_post_action_review_by_admin_id_idx').on(t.postActionReviewByAdminId),
    check('admin_actions_risk_tier_ck', sql`${t.riskTier} in ('high','critical')`),
    check(
      'admin_actions_status_ck',
      sql`${t.status} in ('Pending','Approved','Rejected','Executed','PostActionReviewRequired','PostActionReviewed')`,
    ),
  ],
);

/** Spec 009 §4/§7: at most one decision per `AdminAction` (the unique index below) — the second,
 * distinct admin's approve/reject call. */
export const adminActionApprovals = pgTable(
  'admin_action_approvals',
  {
    ...baseColumns(),
    adminActionId: uuid('admin_action_id')
      .notNull()
      .references(() => adminActions.id, { onDelete: 'restrict' }),
    approverAdminId: uuid('approver_admin_id')
      .notNull()
      .references(() => adminProfiles.id, { onDelete: 'restrict' }),
    decision: text('decision', { enum: ['approved', 'rejected'] as const }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_action_approvals_admin_action_id_idx').on(t.adminActionId),
    index('admin_action_approvals_approver_admin_id_idx').on(t.approverAdminId),
    uniqueIndex('admin_action_approvals_admin_action_uq').on(t.adminActionId),
    check('admin_action_approvals_decision_ck', sql`${t.decision} in ('approved','rejected')`),
  ],
);

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** Spec 010 §4 Lifecycle: shared by Category, Subcategory, and Service. `pending_review` is the
 * status of a catalog entity awaiting publication (either an admin's own draft-for-review, or the
 * unpublished result of an approved AI suggestion) — distinct from `CATALOG_SUGGESTION_STATUSES`
 * below, which tracks the separate `CatalogSuggestion` proposal record, never a catalog entity
 * itself. */
export const CATALOG_ENTITY_STATUSES = ['draft', 'published', 'pending_review', 'retired'] as const;

/** Spec 010 §3 Request/response types: kept a distinct type from `CATALOG_ENTITY_STATUSES` even
 * though both use `pending_review` — a `CatalogSuggestion` has no corresponding catalog row until
 * approved. */
export const CATALOG_SUGGESTION_STATUSES = ['pending_review', 'approved', 'rejected'] as const;

export const PRICING_MODELS = ['fixed', 'package', 'hourly', 'quote', 'custom'] as const;

export const CATALOG_SUGGESTION_ENTITY_TYPES = ['category', 'subcategory', 'service'] as const;

export const categories = pgTable(
  'categories',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status', { enum: CATALOG_ENTITY_STATUSES }).notNull().default('draft'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    uniqueIndex('categories_slug_uq').on(t.slug),
    check('categories_status_ck', sql`${t.status} in ('draft','published','pending_review','retired')`),
  ],
);

export const subcategories = pgTable(
  'subcategories',
  {
    ...baseColumns(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status', { enum: CATALOG_ENTITY_STATUSES }).notNull().default('draft'),
  },
  (t) => [
    index('subcategories_category_id_idx').on(t.categoryId),
    // Spec 010 §3 Slug rules: unique within the parent category, not globally.
    uniqueIndex('subcategories_category_id_slug_uq').on(t.categoryId, t.slug),
    check('subcategories_status_ck', sql`${t.status} in ('draft','published','pending_review','retired')`),
  ],
);

export const services = pgTable(
  'services',
  {
    ...baseColumns(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    // Spec 010 §4 Data model: nullable — not every service belongs to a subcategory.
    subcategoryId: uuid('subcategory_id').references((): AnyPgColumn => subcategories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    pricingModel: text('pricing_model', { enum: PRICING_MODELS }).notNull().default('quote'),
    status: text('status', { enum: CATALOG_ENTITY_STATUSES }).notNull().default('draft'),
    // Service-specific variable data, e.g. typical duration ranges (spec 010 §4).
    metadata: jsonb('metadata').notNull().default({}),
    /**
     * Spec 017 §4 — per-service overrides of the platform matching defaults (master spec §23:
     * "Weights can differ by service"). Null means this service uses
     * `DEFAULT_MATCHING_WEIGHTS` / `DEFAULT_MATCHING_POOL_SIZE` (lib/matching/weights.ts);
     * there is deliberately no row-per-service requirement.
     */
    matchingWeights: jsonb('matching_weights').$type<Record<string, number>>(),
    matchingPoolSize: integer('matching_pool_size'),
  },
  (t) => [
    index('services_category_id_idx').on(t.categoryId),
    index('services_subcategory_id_idx').on(t.subcategoryId),
    // Spec 010 §3 Slug rules: unique across the whole catalog scope (no two services share a slug).
    uniqueIndex('services_slug_uq').on(t.slug),
    check('services_pricing_model_ck', sql`${t.pricingModel} in ('fixed','package','hourly','quote','custom')`),
    check('services_status_ck', sql`${t.status} in ('draft','published','pending_review','retired')`),
    // Spec 017 §3 "Distribution": bounded 1..50 at the database too, so no path can persist an
    // out-of-range pool size even if a future caller skips the route's validation.
    check('services_matching_pool_size_ck', sql`${t.matchingPoolSize} is null or ${t.matchingPoolSize} between 1 and 50`),
  ],
);

/** Spec 010 §4 Data model / AC-3: an AI-proposed category/subcategory/service, never itself a
 * catalog entity. `resultingEntityId` is intentionally untyped as a single FK — it may point at
 * `categories`, `subcategories`, or `services` depending on `entityType`, which no single Postgres
 * FK constraint can express; the application layer (lib/catalog/suggestions.ts) is the source of
 * truth for that relationship, same rationale as `admin_actions.target_id` (spec 009) above. */
export const catalogSuggestions = pgTable(
  'catalog_suggestions',
  {
    ...baseColumns(),
    entityType: text('entity_type', { enum: CATALOG_SUGGESTION_ENTITY_TYPES }).notNull(),
    proposedName: text('proposed_name').notNull(),
    proposedSlug: text('proposed_slug').notNull(),
    categoryId: uuid('category_id').references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    subcategoryId: uuid('subcategory_id').references((): AnyPgColumn => subcategories.id, { onDelete: 'restrict' }),
    pricingModel: text('pricing_model', { enum: PRICING_MODELS }),
    metadata: jsonb('metadata').notNull().default({}),
    rationale: text('rationale'),
    source: text('source').notNull(),
    status: text('status', { enum: CATALOG_SUGGESTION_STATUSES }).notNull().default('pending_review'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
    resultingEntityId: uuid('resulting_entity_id'),
  },
  (t) => [
    index('catalog_suggestions_status_idx').on(t.status),
    index('catalog_suggestions_category_id_idx').on(t.categoryId),
    index('catalog_suggestions_subcategory_id_idx').on(t.subcategoryId),
    index('catalog_suggestions_reviewed_by_idx').on(t.reviewedBy),
    check(
      'catalog_suggestions_entity_type_ck',
      sql`${t.entityType} in ('category','subcategory','service')`,
    ),
    check('catalog_suggestions_status_ck', sql`${t.status} in ('pending_review','approved','rejected')`),
    check(
      'catalog_suggestions_pricing_model_ck',
      sql`${t.pricingModel} is null or ${t.pricingModel} in ('fixed','package','hourly','quote','custom')`,
    ),
  ],
);

/** Spec 011 §4: `text`/`select`/`number`/`boolean`/`media` — the field types both the manual
 * request form and the AI conversational flow (spec 015/034) validate identically against. */
export const SERVICE_FIELD_TYPES = ['text', 'select', 'number', 'boolean', 'media'] as const;

export const serviceFields = pgTable(
  'service_fields',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type', { enum: SERVICE_FIELD_TYPES }).notNull(),
    required: boolean('required').notNull().default(false),
    // `select`'s choice list; nullable for every other `type` (spec 011 §3 VALIDATION_ERROR:
    // "select type with no options" — enforced at the application layer, not a DB constraint,
    // since the required shape of `validation` differs per `type` too).
    options: jsonb('options'),
    validation: jsonb('validation'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('service_fields_service_id_idx').on(t.serviceId),
    // A field's `key` is how spec 015/034 both address it — must be unique per service so neither
    // consumer can address two different fields with the same key.
    uniqueIndex('service_fields_service_id_key_uq').on(t.serviceId, t.key),
    check('service_fields_type_ck', sql`${t.type} in ('text','select','number','boolean','media')`),
  ],
);

/** Spec 011 §4: media/duration/buffer/verification — a service's non-field prerequisites (e.g.
 * "photos recommended", "requires a 30-minute buffer"), distinct from `ServiceField` (which
 * captures a customer-supplied value at request time). */
export const SERVICE_REQUIREMENT_KINDS = ['media', 'duration', 'buffer', 'verification'] as const;

export const serviceRequirements = pgTable(
  'service_requirements',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: SERVICE_REQUIREMENT_KINDS }).notNull(),
    detail: jsonb('detail').notNull().default({}),
  },
  (t) => [
    index('service_requirements_service_id_idx').on(t.serviceId),
    check('service_requirements_kind_ck', sql`${t.kind} in ('media','duration','buffer','verification')`),
  ],
);

/** Spec 011 §4/AC-5/AC-6: `provider_profile_id` null = an official (admin-authored) FAQ — named
 * to match every other `ProviderProfile` FK in this file (`provider_services` etc.), never the
 * bare `provider_id` an earlier draft of spec 011 used. `source` records who authored it;
 * `status` gates AI-suggested content specifically (`ai_suggested` starts `pending_review` and
 * only an admin's explicit approval — never the AI itself — sets `published`). Official and
 * provider-authored FAQs publish immediately on creation; there is no review gate for those (no
 * such endpoint exists in spec 011 §3), only for `ai_suggested`. */
export const SERVICE_FAQ_SOURCES = ['official', 'provider', 'ai_suggested'] as const;
export const SERVICE_FAQ_STATUSES = ['published', 'pending_review'] as const;

export const serviceFaqs = pgTable(
  'service_faqs',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id').references((): AnyPgColumn => providerProfiles.id, { onDelete: 'restrict' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    source: text('source', { enum: SERVICE_FAQ_SOURCES }).notNull(),
    status: text('status', { enum: SERVICE_FAQ_STATUSES }).notNull().default('pending_review'),
  },
  (t) => [
    index('service_faqs_service_id_idx').on(t.serviceId),
    index('service_faqs_provider_profile_id_idx').on(t.providerProfileId),
    check('service_faqs_source_ck', sql`${t.source} in ('official','provider','ai_suggested')`),
    check('service_faqs_status_ck', sql`${t.status} in ('published','pending_review')`),
  ],
);

export const servicePackages = pgTable(
  'service_packages',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id').references((): AnyPgColumn => providerProfiles.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    amountMinorUnits: integer('amount_minor_units').notNull(),
    currencyCode: text('currency_code').notNull(),
    includedItems: jsonb('included_items').notNull().default([]),
  },
  (t) => [
    index('service_packages_service_id_idx').on(t.serviceId),
    index('service_packages_provider_profile_id_idx').on(t.providerProfileId),
    // Same pair/format rule as `moneyPairChecks` (spec 003 §AC-1), applied directly since spec
    // 011 §4 names these columns without the `moneyColumns(base)` helper's base-prefix convention.
    check('service_packages_currency_format_ck', sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

// ---------------------------------------------------------------------------
// Provider catalog & availability
// ---------------------------------------------------------------------------

export const providerServices = pgTable(
  'provider_services',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    /**
     * Spec 016 §4 — master spec §40's "service-specific durations" and "buffer times". These are
     * properties of what the PROVIDER offers, not of any booking row: `bookings` stays untouched
     * by spec 016 (its scheduling columns are approved spec 020's, per spec 003 AC-4).
     * `duration_minutes` drives spec 016 §3 R7's slot generation; the two buffers widen an
     * already-occupied interval per R8.
     */
    durationMinutes: integer('duration_minutes').notNull().default(60),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
  },
  (t) => [
    index('provider_services_provider_profile_id_idx').on(t.providerProfileId),
    index('provider_services_service_id_idx').on(t.serviceId),
    uniqueIndex('provider_services_provider_service_uq').on(t.providerProfileId, t.serviceId),
    check('provider_services_duration_positive_ck', sql`${t.durationMinutes} > 0`),
    check('provider_services_buffers_non_negative_ck', sql`${t.bufferBeforeMinutes} >= 0 and ${t.bufferAfterMinutes} >= 0`),
  ],
);

/**
 * Spec 016 §4 — the provider's recurring weekly pattern (master spec §40). Times are integer
 * MINUTES FROM LOCAL MIDNIGHT, not `time`: they are wall-clock values in the provider's
 * `provider_profiles.scheduling_timezone` (§3 R1), and integer arithmetic makes R2's
 * overlap/touch rule and R7's half-open boundaries exact. `end_minute` may be 1440 ("to
 * midnight"); `start_minute` may not, since a zero-length window is meaningless (R6).
 *
 * R2's "two entries on the same day must not overlap or touch" holds ACROSS rows, so it cannot be
 * a per-row CHECK — `PUT /providers/me/availability/schedule` replaces the whole weekly set in one
 * transaction and validates it there (lib/availability/resolve.ts).
 */
export const providerAvailabilities = pgTable(
  'provider_availabilities',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    /** 0 = Sunday, matching JS `Date#getDay()` (spec 016 §3 `WeeklyScheduleEntry`). */
    dayOfWeek: integer('day_of_week').notNull(),
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
  },
  (t) => [
    index('provider_availabilities_provider_profile_id_idx').on(t.providerProfileId),
    index('provider_availabilities_provider_day_idx').on(t.providerProfileId, t.dayOfWeek),
    check('provider_availabilities_day_of_week_ck', sql`${t.dayOfWeek} between 0 and 6`),
    check('provider_availabilities_start_minute_ck', sql`${t.startMinute} between 0 and 1439`),
    check('provider_availabilities_end_minute_ck', sql`${t.endMinute} between 1 and 1440`),
    check('provider_availabilities_range_ck', sql`${t.startMinute} < ${t.endMinute}`),
  ],
);

/**
 * Spec 016 §4 / §3 R3–R4 — a date-specific override that WHOLLY REPLACES the weekly pattern for
 * that local date; it is never merged, unioned or intersected with it. `is_available = false` is
 * master spec §40's "blocked period" (whole day off, both minutes null); `is_available = true`
 * requires both minutes and defines the day's only window. One row per date (R4), so there is no
 * duplicate-override ambiguity to resolve at read time.
 */
export const providerAvailabilityOverrides = pgTable(
  'provider_availability_overrides',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    /** Local calendar date in the provider's scheduling timezone, stored as `date` (no zone). */
    date: date('date').notNull(),
    isAvailable: boolean('is_available').notNull(),
    startMinute: integer('start_minute'),
    endMinute: integer('end_minute'),
  },
  (t) => [
    index('provider_availability_overrides_provider_profile_id_idx').on(t.providerProfileId),
    uniqueIndex('provider_availability_overrides_provider_date_uq').on(t.providerProfileId, t.date),
    check('provider_availability_overrides_start_pairing_ck', sql`(${t.isAvailable} = false) = (${t.startMinute} is null)`),
    check('provider_availability_overrides_end_pairing_ck', sql`(${t.isAvailable} = false) = (${t.endMinute} is null)`),
    check(
      'provider_availability_overrides_range_ck',
      sql`${t.startMinute} is null or (${t.startMinute} between 0 and 1439 and ${t.endMinute} between 1 and 1440 and ${t.startMinute} < ${t.endMinute})`,
    ),
  ],
);

/** Spec 016 §3 S1/S5 — master spec §41's radius / specific-cities / remote-online coverage. */
export const PROVIDER_SERVICE_AREA_MODES = ['radius', 'cities', 'remote'] as const;

/**
 * Spec 016 §4 / §3 S1–S5. A row with `service_id IS NULL` is the provider's GLOBAL default; a row
 * with a `service_id` is that service's own area and wins over the global one (S2). No row at all
 * means unrestricted — preserving exactly the behaviour spec 012's `service-area-check` shipped
 * with.
 *
 * Radius is `radius_meters integer`, never `radius_km numeric`: schema-lint AC-1 bans
 * numeric/real/double schema-wide, the same reason coordinates are micro-degree integers. The
 * centre is an `addresses` row (owned by the provider's user), whose `location_id` carries the
 * coordinates — so this never stores a second copy of a point, and `center_address_id` is what
 * spec 016 §3 exports to the owner instead of raw coordinates.
 */
export const providerServiceAreas = pgTable(
  'provider_service_areas',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    /** null = the provider-wide default (S1). */
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'restrict' }),
    mode: text('mode', { enum: PROVIDER_SERVICE_AREA_MODES }).notNull(),
    radiusMeters: integer('radius_meters'),
    centerAddressId: uuid('center_address_id').references((): AnyPgColumn => addresses.id, { onDelete: 'restrict' }),
    cities: jsonb('cities').$type<string[]>(),
  },
  (t) => [
    index('provider_service_areas_provider_profile_id_idx').on(t.providerProfileId),
    index('provider_service_areas_service_id_idx').on(t.serviceId),
    index('provider_service_areas_center_address_id_idx').on(t.centerAddressId),
    // S1: at most one row per (provider, service) — and, via the partial index, at most one
    // global row, which a plain UNIQUE cannot express (Postgres UNIQUE allows multiple NULLs).
    uniqueIndex('provider_service_areas_provider_service_uq').on(t.providerProfileId, t.serviceId),
    uniqueIndex('provider_service_areas_provider_global_uq')
      .on(t.providerProfileId)
      .where(sql`${t.serviceId} is null`),
    check('provider_service_areas_mode_ck', sql`${t.mode} in ('radius','cities','remote')`),
    check(
      'provider_service_areas_radius_shape_ck',
      sql`(${t.mode} <> 'radius') or (${t.radiusMeters} is not null and ${t.centerAddressId} is not null and ${t.radiusMeters} between 1000 and 500000)`,
    ),
    check('provider_service_areas_cities_shape_ck', sql`(${t.mode} <> 'cities') or (${t.cities} is not null)`),
    check(
      'provider_service_areas_remote_shape_ck',
      sql`(${t.mode} <> 'remote') or (${t.radiusMeters} is null and ${t.centerAddressId} is null and ${t.cities} is null)`,
    ),
  ],
);

/** Spec 016 §4 / AC-6 — statuses of a customer's availability-notification opt-in. */
export const AVAILABILITY_NOTIFICATION_STATUSES = ['pending', 'sent', 'cancelled'] as const;

/**
 * Spec 016 §4 / AC-6 (master spec §42: "Customer can save/follow provider and optionally request
 * availability notifications"). Not in master spec §124's minimum entity list — added here the
 * same way spec 009 added `admin_role_assignments`, per spec 003 AC-4.
 *
 * The partial unique index is AC-6's idempotency: a second opt-in while one is still `pending`
 * cannot create a duplicate row, so the route returns the existing one with `200` instead.
 * Delivery itself is spec 026's (spec 016 §7) — this table only records the opt-in.
 */
export const providerAvailabilityNotificationRequests = pgTable(
  'provider_availability_notification_requests',
  {
    ...baseColumns(),
    customerProfileId: uuid('customer_profile_id')
      .notNull()
      .references(() => customerProfiles.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    status: text('status', { enum: AVAILABILITY_NOTIFICATION_STATUSES }).notNull().default('pending'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => [
    index('provider_availability_notification_requests_customer_profile_id_idx').on(t.customerProfileId),
    index('provider_availability_notification_requests_provider_profile_id_idx').on(t.providerProfileId),
    uniqueIndex('provider_availability_notification_requests_pending_uq')
      .on(t.customerProfileId, t.providerProfileId)
      .where(sql`${t.status} = 'pending'`),
    check('provider_availability_notification_requests_status_ck', sql`${t.status} in ('pending','sent','cancelled')`),
  ],
);

// ---------------------------------------------------------------------------
// Requests (state machine: AC-3)
// ---------------------------------------------------------------------------

/** Spec 015 §4 — master spec §125's request states. `draft` is an internal, single-transaction
 * step (spec 015 §4 "Creation is one transaction"), never customer-visible. */
export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'matching',
  'offers_open',
  'provider_selected',
  'booking_created',
  'cancelled',
  'expired',
  'completed',
] as const;

/** Spec 015 §4 — master spec §28's urgency. */
export const REQUEST_URGENCIES = ['normal', 'urgent'] as const;

// Spec 015 §4: master spec §27's budget shapes need two money pairs (one pair cannot express a
// range). `moneyColumns`/`moneyPairChecks` take the *column* base name, so it is snake_case here;
// the resulting columns are destructured onto camelCase properties below, so the TS field names
// stay consistent with every other column in this file.
const budgetMinColumns = moneyColumns('budget_min');
const budgetMaxColumns = moneyColumns('budget_max');
const preferredTimeColumns = scheduledTimeColumns('preferred');

export const requests = pgTable(
  'requests',
  {
    ...baseColumns(),
    customerProfileId: uuid('customer_profile_id')
      .notNull()
      .references(() => customerProfiles.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    status: text('status', { enum: REQUEST_STATUSES }).notNull(),
    /** Spec 015 §4 — feature columns. The table itself is spec 003's baseline skeleton. */
    description: text('description').notNull(),
    budgetMinAmountMinorUnits: budgetMinColumns.budget_minAmountMinorUnits,
    budgetMinCurrencyCode: budgetMinColumns.budget_minCurrencyCode,
    budgetMaxAmountMinorUnits: budgetMaxColumns.budget_maxAmountMinorUnits,
    budgetMaxCurrencyCode: budgetMaxColumns.budget_maxCurrencyCode,
    preferredAt: preferredTimeColumns.preferredAt,
    preferredTimezone: preferredTimeColumns.preferredTimezone,
    addressId: uuid('address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),
    urgency: text('urgency', { enum: REQUEST_URGENCIES }).notNull(),
    /** Spec 015 §3 idempotency: scoped per customer by the unique index below, never globally. */
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
  },
  (t) => [
    index('requests_customer_profile_id_idx').on(t.customerProfileId),
    index('requests_service_id_idx').on(t.serviceId),
    index('requests_address_id_idx').on(t.addressId),
    // Spec 017 reads "every request in `submitted`" — its covering index, added here with the
    // column it reads rather than left for that spec to retrofit.
    index('requests_status_idx').on(t.status),
    uniqueIndex('requests_customer_idempotency_key_uq').on(t.customerProfileId, t.idempotencyKey),
    ...moneyPairChecks('requests', 'budget_min'),
    ...moneyPairChecks('requests', 'budget_max'),
    check('requests_status_ck', sql`${t.status} in ('draft','submitted','matching','offers_open','provider_selected','booking_created','cancelled','expired','completed')`),
    check('requests_urgency_ck', sql`${t.urgency} in ('normal','urgent')`),
    // Spec 015 §4 budget semantics: omitted -> all four null; target amount -> min = max;
    // range -> min < max. Both pairs are always null together or set together.
    check(
      'requests_budget_pair_ck',
      sql`(${t.budgetMinAmountMinorUnits} is null) = (${t.budgetMaxAmountMinorUnits} is null)`,
    ),
    check(
      'requests_budget_order_ck',
      sql`${t.budgetMinAmountMinorUnits} is null or ${t.budgetMinAmountMinorUnits} <= ${t.budgetMaxAmountMinorUnits}`,
    ),
    check(
      'requests_budget_currency_match_ck',
      sql`${t.budgetMinCurrencyCode} is null or ${t.budgetMinCurrencyCode} = ${t.budgetMaxCurrencyCode}`,
    ),
    check(
      'requests_budget_positive_ck',
      sql`${t.budgetMinAmountMinorUnits} is null or ${t.budgetMinAmountMinorUnits} > 0`,
    ),
  ],
);

export const requestFieldValues = pgTable(
  'request_field_values',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    serviceFieldId: uuid('service_field_id')
      .notNull()
      .references(() => serviceFields.id, { onDelete: 'restrict' }),
    /** Spec 015 §4: the customer-supplied value, whose JSON type is genuinely variable per
     * `ServiceField.type` (text/select/number/boolean/media) and is never queried or filtered on —
     * the reviewed jsonb exception registered in lib/db/schema-lint.test.ts's allowlist. */
    value: jsonb('value').notNull(),
  },
  (t) => [
    index('request_field_values_request_id_idx').on(t.requestId),
    index('request_field_values_service_field_id_idx').on(t.serviceFieldId),
    uniqueIndex('request_field_values_request_field_uq').on(t.requestId, t.serviceFieldId),
  ],
);

export const requestAttachments = pgTable(
  'request_attachments',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    /** Spec 015 §3/§4: the linkage only. Upload, size/MIME/scan state and the count/size limits
     * are spec 027's (§8 #1 — deliberately unresolved here, never invented). */
    fileAssetId: uuid('file_asset_id')
      .notNull()
      .references(() => fileAssets.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('request_attachments_request_id_idx').on(t.requestId),
    index('request_attachments_file_asset_id_idx').on(t.fileAssetId),
  ],
);

/** Spec 017 §3 AC-1 — why a provider was excluded before ranking. `at_capacity` is RESERVED:
 * E5 is a documented no-op this release (spec 017 DECIDED-1), so no code path emits it. */
export const MATCH_EXCLUSION_REASONS = [
  'service_not_offered',
  'outside_service_area',
  'unavailable',
  'not_verified',
  'at_capacity',
] as const;

/** Spec 017 §3 AC-5 — a provider's response to a distributed request. A response vocabulary, not
 * a state machine: spec 003 AC-3 reserves `*_status_history`/`*_status_transitions` for Request,
 * Offer, Booking, Payment and Payout, and this is none of them. `offer_sent` is written by spec
 * 018, never by spec 017. */
export const PROVIDER_RESPONSES = ['none', 'accepted', 'declined', 'offer_sent'] as const;

/**
 * Spec 017 §4 — extends spec 003's baseline skeleton (which already carried the two FKs, their
 * covering indexes, and the `(request_id, provider_profile_id)` unique index that gives AC-4's
 * distribution idempotency for free).
 *
 * One row per (request, provider) candidate — INCLUDING excluded candidates, which is what makes
 * AC-6's admin explainability possible: an exclusion is recorded, not merely absent.
 */
export const requestProviderMatches = pgTable(
  'request_provider_matches',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    /** Spec 017 AC-1: false = failed a hard eligibility rule, never ranked. */
    eligible: boolean('eligible').notNull(),
    exclusionReason: text('exclusion_reason', { enum: MATCH_EXCLUSION_REASONS }),
    /** 1-based position within the eligible pool; null for an excluded candidate. */
    rank: integer('rank'),
    /**
     * Spec 017 §3: score x 1,000,000 as an integer — NEVER a float. `lib/db/schema-lint.test.ts`
     * (spec 003 AC-1) bans numeric/real/double schema-wide; this is the same fixed-point approach
     * `locations` uses for coordinates.
     */
    scoreMicros: integer('score_micros'),
    scoreBreakdown: jsonb('score_breakdown'),
    /** Spec 017 AC-3: entered the pool via a reserved exploration slot rather than organically. */
    explorationBoosted: boolean('exploration_boosted').notNull().default(false),
    /** Spec 017 AC-4: null = ranked but not distributed. Delivery itself is spec 026's. */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    providerResponse: text('provider_response', { enum: PROVIDER_RESPONSES }).notNull().default('none'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => [
    index('request_provider_matches_request_id_idx').on(t.requestId),
    index('request_provider_matches_provider_profile_id_idx').on(t.providerProfileId),
    uniqueIndex('request_provider_matches_request_provider_uq').on(t.requestId, t.providerProfileId),
    // Spec 017 §4: the ranked read (admin explainability, distribution) and the provider's inbox.
    index('request_provider_matches_request_rank_idx').on(t.requestId, t.rank),
    index('request_provider_matches_provider_notified_idx').on(t.providerProfileId, t.notifiedAt),
    /**
     * Spec 017 §3 "Concurrency" — the DATABASE half of the claim invariant: at most one provider
     * may hold `accepted` for a request. Independent of the application's `SELECT ... FOR UPDATE`,
     * so even a code path that skipped the lock cannot produce two accepted providers.
     */
    uniqueIndex('request_provider_matches_accepted_uq')
      .on(t.requestId)
      .where(sql`${t.providerResponse} = 'accepted'`),
    check(
      'request_provider_matches_exclusion_pairing_ck',
      sql`(${t.eligible} = false) = (${t.exclusionReason} is not null)`,
    ),
    // An excluded candidate is never ranked or scored (AC-1: excluded before ranking ever runs).
    check(
      'request_provider_matches_excluded_unranked_ck',
      sql`${t.eligible} = true or (${t.rank} is null and ${t.scoreMicros} is null)`,
    ),
    check(
      'request_provider_matches_response_pairing_ck',
      sql`(${t.providerResponse} = 'none') = (${t.respondedAt} is null)`,
    ),
    check(
      'request_provider_matches_score_range_ck',
      sql`${t.scoreMicros} is null or ${t.scoreMicros} between 0 and 1000000`,
    ),
    check(
      'request_provider_matches_exclusion_reason_ck',
      sql`${t.exclusionReason} is null or ${t.exclusionReason} in ('service_not_offered','outside_service_area','unavailable','not_verified','at_capacity')`,
    ),
    check(
      'request_provider_matches_provider_response_ck',
      sql`${t.providerResponse} in ('none','accepted','declined','offer_sent')`,
    ),
  ],
);

/** Spec 017 §4 / AC-7 — status vocabulary, deliberately identical to `catalog_suggestions`. */
export const MATCHING_SUGGESTION_STATUSES = ['pending_review', 'approved', 'rejected'] as const;

/**
 * Spec 017 §4 / AC-7 (master spec §23, §132.16): an AI-proposed ranking-weight change, recorded
 * for admin review and NEVER silently applied. Shaped to match the already-shipped
 * `catalog_suggestions` table (spec 010) field-for-field where the concepts align, so the review
 * workflow and its audit fields follow one pattern rather than two.
 *
 * Applying a suggestion is a separate, explicitly authorized admin action that writes
 * `services.matching_weights`; nothing in this table is ever read by the scoring path.
 */
export const matchingSuggestions = pgTable(
  'matching_suggestions',
  {
    ...baseColumns(),
    /** null = a proposed change to the platform defaults rather than one service. */
    serviceId: uuid('service_id').references((): AnyPgColumn => services.id, { onDelete: 'restrict' }),
    suggestedWeights: jsonb('suggested_weights').$type<Record<string, number>>().notNull(),
    rationale: text('rationale'),
    source: text('source').notNull(),
    status: text('status', { enum: MATCHING_SUGGESTION_STATUSES }).notNull().default('pending_review'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('matching_suggestions_service_id_idx').on(t.serviceId),
    index('matching_suggestions_reviewed_by_idx').on(t.reviewedBy),
    index('matching_suggestions_status_idx').on(t.status),
    check('matching_suggestions_status_ck', sql`${t.status} in ('pending_review','approved','rejected')`),
  ],
);

export const requestsStatusHistory = pgTable(
  'requests_status_history',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('requests_status_history_request_id_idx').on(t.requestId),
    index('requests_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const requestsStatusTransitions = pgTable(
  'requests_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('requests_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Offers (state machine: AC-3)
// ---------------------------------------------------------------------------

/** Spec 018 §3 / master spec §125 offer vocabulary. `revised` is RESERVED for spec 019 and never
 * written by spec 018; `draft` never leaves the creating transaction. */
export const OFFER_STATUSES = ['draft', 'sent', 'viewed', 'revised', 'accepted', 'declined', 'expired', 'withdrawn'] as const;

const offerPrice = moneyColumns('price');

/**
 * Spec 018 §4 — extends spec 003's baseline skeleton. The 2-minute window is enforced by the
 * database itself: `expires_at` must equal `sent_at + interval '2 minutes'` (CHECK below), and both
 * are written from a single `clock_timestamp()` read in one statement (lib/offers/create.ts) — never
 * computed in application code or supplied by a client.
 */
export const offers = pgTable(
  'offers',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    status: text('status', { enum: OFFER_STATUSES }).notNull(),
    priceAmountMinorUnits: offerPrice.priceAmountMinorUnits.notNull(),
    priceCurrencyCode: offerPrice.priceCurrencyCode.notNull(),
    includedItems: jsonb('included_items').$type<string[]>().notNull().default([]),
    providerMessage: text('provider_message'),
    estimatedDurationMinutes: integer('estimated_duration_minutes'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
    acceptIdempotencyKey: text('accept_idempotency_key'),
  },
  (t) => [
    index('offers_request_id_idx').on(t.requestId),
    index('offers_provider_profile_id_idx').on(t.providerProfileId),
    ...moneyPairChecks('offers', 'price'),
    check('offers_price_positive_ck', sql`${t.priceAmountMinorUnits} > 0`),
    check('offers_status_ck', sql`${t.status} in ('draft','sent','viewed','revised','accepted','declined','expired','withdrawn')`),
    check(
      'offers_estimated_duration_ck',
      sql`${t.estimatedDurationMinutes} is null or ${t.estimatedDurationMinutes} between 1 and 1440`,
    ),
    check('offers_draft_unsent_ck', sql`(${t.status} = 'draft') = (${t.sentAt} is null)`),
    check('offers_sent_expires_pair_ck', sql`(${t.sentAt} is null) = (${t.expiresAt} is null)`),
    // Master spec §32: exactly 2 minutes, never configurable, never extended.
    check('offers_two_minute_window_ck', sql`${t.expiresAt} is null or ${t.expiresAt} = ${t.sentAt} + interval '2 minutes'`),
    check(
      'offers_decided_pairing_ck',
      sql`(${t.decidedAt} is not null) = (${t.status} in ('accepted','declined','withdrawn'))`,
    ),
    check('offers_accept_key_pairing_ck', sql`(${t.acceptIdempotencyKey} is not null) = (${t.status} = 'accepted')`),
    uniqueIndex('offers_provider_idempotency_key_uq').on(t.providerProfileId, t.idempotencyKey),
    // At most one live offer per provider per request (spec 018 AC-5).
    uniqueIndex('offers_request_provider_live_uq')
      .on(t.requestId, t.providerProfileId)
      .where(sql`${t.status} in ('draft','sent','viewed')`),
    // At most one accepted offer per request (spec 018 AC-6) — independent of the application lock.
    uniqueIndex('offers_request_accepted_uq').on(t.requestId).where(sql`${t.status} = 'accepted'`),
    index('offers_status_expires_at_idx').on(t.status, t.expiresAt),
    index('offers_request_sent_at_idx').on(t.requestId, t.sentAt),
  ],
);

/** Spec 019 §4 — the most revisions a provider may make on one request. */
export const MAX_REVISIONS_PER_REQUEST_PROVIDER = 5;

const revisionPreviousPrice = moneyColumns('previous_price');
const revisionNewPrice = moneyColumns('new_price');

/**
 * Spec 019 §4 — extends spec 003's baseline skeleton. One row per revision: `offer_id` is the
 * superseded SOURCE offer (the baseline column), `new_offer_id` the row the revision created. Rows are
 * append-only (trigger `offer_revisions_append_only_trg`, migration 0015) — they are the audit record
 * behind every price change and behind spec 020's accepted price.
 */
export const offerRevisions = pgTable(
  'offer_revisions',
  {
    ...baseColumns(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    newOfferId: uuid('new_offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    revisionNumber: integer('revision_number').notNull(),
    previousPriceAmountMinorUnits: revisionPreviousPrice.previous_priceAmountMinorUnits.notNull(),
    previousPriceCurrencyCode: revisionPreviousPrice.previous_priceCurrencyCode.notNull(),
    newPriceAmountMinorUnits: revisionNewPrice.new_priceAmountMinorUnits.notNull(),
    newPriceCurrencyCode: revisionNewPrice.new_priceCurrencyCode.notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    changeRequestMessageId: uuid('change_request_message_id').references((): AnyPgColumn => offerMessages.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    index('offer_revisions_offer_id_idx').on(t.offerId),
    // A row is revised at most once — no forked chains.
    uniqueIndex('offer_revisions_offer_id_uq').on(t.offerId),
    uniqueIndex('offer_revisions_new_offer_id_uq').on(t.newOfferId),
    index('offer_revisions_request_id_idx').on(t.requestId),
    index('offer_revisions_provider_profile_id_idx').on(t.providerProfileId),
    index('offer_revisions_actor_user_id_idx').on(t.actorUserId),
    index('offer_revisions_change_request_message_id_idx').on(t.changeRequestMessageId),
    uniqueIndex('offer_revisions_request_provider_number_uq').on(t.requestId, t.providerProfileId, t.revisionNumber),
    check('offer_revisions_number_ck', sql`${t.revisionNumber} between 1 and 5`),
    check('offer_revisions_distinct_offers_ck', sql`${t.offerId} <> ${t.newOfferId}`),
    ...moneyPairChecks('offer_revisions', 'previous_price'),
    ...moneyPairChecks('offer_revisions', 'new_price'),
    check('offer_revisions_prices_positive_ck', sql`${t.previousPriceAmountMinorUnits} > 0 and ${t.newPriceAmountMinorUnits} > 0`),
    check('offer_revisions_same_currency_ck', sql`${t.previousPriceCurrencyCode} = ${t.newPriceCurrencyCode}`),
  ],
);

/** Spec 019 §3 — who wrote a pre-selection thread row, and what kind of row it is. */
export const NEGOTIATION_SENDER_ROLES = ['customer', 'provider'] as const;
export const OFFER_MESSAGE_KINDS = ['message', 'change_request'] as const;

const proposedPrice = moneyColumns('proposed_price');

/**
 * Spec 019 §4 — extends spec 003's baseline skeleton into the pre-selection thread. A thread is the
 * (request, provider) pair; `offer_id` is set only for a `change_request`. `body` is always stored
 * ALREADY REDACTED (lib/negotiation/contact-redaction.ts) — the unredacted text is never persisted.
 */
export const offerMessages = pgTable(
  'offer_messages',
  {
    ...baseColumns(),
    offerId: uuid('offer_id').references(() => offers.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    senderRole: text('sender_role', { enum: NEGOTIATION_SENDER_ROLES }).notNull(),
    kind: text('kind', { enum: OFFER_MESSAGE_KINDS }).notNull(),
    body: text('body').notNull(),
    contactRedacted: boolean('contact_redacted').notNull().default(false),
    proposedPriceAmountMinorUnits: proposedPrice.proposed_priceAmountMinorUnits,
    proposedPriceCurrencyCode: proposedPrice.proposed_priceCurrencyCode,
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
  },
  (t) => [
    index('offer_messages_offer_id_idx').on(t.offerId),
    index('offer_messages_sender_user_id_idx').on(t.senderUserId),
    index('offer_messages_request_id_idx').on(t.requestId),
    index('offer_messages_provider_profile_id_idx').on(t.providerProfileId),
    // Thread reads and the per-sender anti-spam count (spec 019 §3).
    index('offer_messages_thread_created_at_idx').on(t.requestId, t.providerProfileId, t.createdAt),
    uniqueIndex('offer_messages_sender_idempotency_key_uq').on(t.senderUserId, t.idempotencyKey),
    uniqueIndex('offer_messages_change_request_per_offer_uq').on(t.offerId).where(sql`${t.kind} = 'change_request'`),
    check('offer_messages_sender_role_ck', sql`${t.senderRole} in ('customer','provider')`),
    check('offer_messages_kind_ck', sql`${t.kind} in ('message','change_request')`),
    check('offer_messages_body_length_ck', sql`char_length(${t.body}) between 1 and 1100`),
    check('offer_messages_change_request_offer_ck', sql`(${t.kind} = 'change_request') = (${t.offerId} is not null)`),
    check(
      'offer_messages_proposed_price_kind_ck',
      sql`${t.kind} = 'change_request' or ${t.proposedPriceAmountMinorUnits} is null`,
    ),
    check('offer_messages_change_request_sender_ck', sql`${t.kind} = 'message' or ${t.senderRole} = 'customer'`),
    ...moneyPairChecks('offer_messages', 'proposed_price'),
    check(
      'offer_messages_proposed_price_positive_ck',
      sql`${t.proposedPriceAmountMinorUnits} is null or ${t.proposedPriceAmountMinorUnits} > 0`,
    ),
  ],
);

export const offersStatusHistory = pgTable(
  'offers_status_history',
  {
    ...baseColumns(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('offers_status_history_offer_id_idx').on(t.offerId),
    index('offers_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const offersStatusTransitions = pgTable(
  'offers_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('offers_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Bookings (state machine: AC-3)
// ---------------------------------------------------------------------------

/**
 * Spec 020 §4 — master spec §125's booking states. Authored **once**, here: later specs add
 * transitions into `bookings_status_transitions`, never a new status name. `protected`/`settled`
 * are spec 021's to reach, `cancelled` spec 023's, `disputed` spec 031's, `refunded` spec 022's,
 * `failed` spec 021's — spec 020 seeds none of those transitions (§3 "Payment boundary").
 */
export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'provider_en_route',
  'arrived',
  'in_progress',
  'completed',
  'protected',
  'settled',
  'cancelled',
  'disputed',
  'refunded',
  'failed',
] as const;

/** Spec 020 §4 — the agreed price, copied verbatim from the accepted offer row. */
const bookingPriceColumns = moneyColumns('price');
/** Spec 020 §4 — resolves spec 016 §8 risk #7: the instant plus the IANA zone it is local to. */
const bookingScheduledColumns = scheduledTimeColumns('scheduled');

export const bookings = pgTable(
  'bookings',
  {
    ...baseColumns(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    status: text('status', { enum: BOOKING_STATUSES }).notNull(),
    /** Spec 020 §4 — feature columns. The table itself is spec 003's baseline skeleton. */
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    customerProfileId: uuid('customer_profile_id')
      .notNull()
      .references(() => customerProfiles.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    addressId: uuid('address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),
    scheduledAt: bookingScheduledColumns.scheduledAt.notNull(),
    /** The provider's `scheduling_timezone` — the zone every window/override/slot was resolved in. */
    scheduledTimezone: bookingScheduledColumns.scheduledTimezone.notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    priceAmountMinorUnits: bookingPriceColumns.priceAmountMinorUnits.notNull(),
    priceCurrencyCode: bookingPriceColumns.priceCurrencyCode.notNull(),
    /** Spec 020 §3 idempotency: scoped per customer by the unique index below, never globally. */
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
  },
  (t) => [
    index('bookings_request_id_idx').on(t.requestId),
    index('bookings_service_id_idx').on(t.serviceId),
    index('bookings_customer_profile_id_idx').on(t.customerProfileId),
    index('bookings_provider_profile_id_idx').on(t.providerProfileId),
    index('bookings_address_id_idx').on(t.addressId),
    // Spec 020 §4 I-3: one booking per offer, independent of the application check.
    uniqueIndex('bookings_offer_id_uq').on(t.offerId),
    // Spec 020 §4 I-4: idempotency scoped per customer (never globally), as spec 015/018 do.
    uniqueIndex('bookings_customer_idempotency_key_uq').on(t.customerProfileId, t.idempotencyKey),
    // The index the spec 016 `BusyIntervalLoader` reads on every reservation.
    index('bookings_provider_scheduled_at_idx').on(t.providerProfileId, t.scheduledAt),
    index('bookings_status_idx').on(t.status),
    index('bookings_customer_scheduled_at_idx').on(t.customerProfileId, t.scheduledAt),
    ...moneyPairChecks('bookings', 'price'),
    check('bookings_price_positive_ck', sql`${t.priceAmountMinorUnits} > 0`),
    check('bookings_duration_positive_ck', sql`${t.durationMinutes} between 1 and 1440`),
    check(
      'bookings_status_ck',
      sql`${t.status} in ('pending','confirmed','provider_en_route','arrived','in_progress','completed','protected','settled','cancelled','disputed','refunded','failed')`,
    ),
  ],
);

export const bookingMilestones = pgTable(
  'booking_milestones',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
  },
  (t) => [index('booking_milestones_booking_id_idx').on(t.bookingId)],
);

export const bookingsStatusHistory = pgTable(
  'bookings_status_history',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Spec 020 §4 — the ONE column this spec adds here. `actor_user_id` is nullable for spec 021's
     * system-driven `protected`/`settled`, and a user holding both a customer and a provider
     * profile on one booking would otherwise be unattributable (§3 "Authorization matrix").
     */
    actorRole: text('actor_role', { enum: ['customer', 'provider', 'system'] as const }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bookings_status_history_booking_id_idx').on(t.bookingId),
    index('bookings_status_history_actor_user_id_idx').on(t.actorUserId),
    check('bookings_status_history_actor_role_ck', sql`${t.actorRole} in ('customer','provider','system')`),
    // Spec 020 §4 I-8: a real user unless the actor is the system.
    check('bookings_status_history_actor_pairing_ck', sql`(${t.actorUserId} is null) = (${t.actorRole} = 'system')`),
  ],
);

export const bookingsStatusTransitions = pgTable(
  'bookings_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('bookings_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Payments & payouts (state machines: AC-3)
// ---------------------------------------------------------------------------

/**
 * Spec 021 §4 — the WHOLE `payments.status` vocabulary, authored once here the way spec 020
 * authored the booking vocabulary. `refunded`/`partially_refunded` are named here but their
 * TRANSITIONS are seeded by spec 022 in its own migration; spec 021 seeds only what it performs.
 */
export const PAYMENT_STATUSES = [
  'created',
  'requires_action',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'partially_refunded',
] as const;

export const PAYMENT_PROTECTION_STATES = ['held', 'released', 'disputed'] as const;

export const PRICE_ADJUSTMENT_STATUSES = ['pending_approval', 'approved', 'rejected', 'charged', 'failed'] as const;

/**
 * Spec 021 §4 — the baseline `payments` skeleton, now carrying this spec's feature columns.
 *
 * ALTERED, never recreated: spec 003 already ships this table, its FK, its index and the
 * `payments_status_transition_trg` trigger. `0017_add_payment_processing_protection.sql` adds the
 * columns below; `0001_baseline_schema.sql` is immutable and untouched.
 *
 * Money follows spec 003 AC-1's convention — a semantically named `<base>_amount_minor_units` +
 * `<base>_currency_code` pair, never numeric/float.
 */
export const payments = pgTable(
  'payments',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
    /** Spec 021 §4 — feature columns. The table itself is spec 003's baseline skeleton. */
    ...moneyColumns('charge'),
    /** Null until the protection window opens on booking completion (AC-5a). */
    protectionState: text('protection_state', { enum: PAYMENT_PROTECTION_STATES }),
    /** The `in_progress -> completed` history instant — never the sweep's own clock (AC-5a). */
    protectionWindowStartedAt: timestamp('protection_window_started_at', { withTimezone: true }),
    protectionWindowHours: integer('protection_window_hours').notNull().default(48),
    /** Which adapter produced this row, e.g. `sandbox`. Never serialized into a DTO or export. */
    providerName: text('provider_name').notNull(),
    /** The provider's opaque handle. Server-side only (spec 021 §4 "Retention and privacy"). */
    providerReference: text('provider_reference'),
    /** Spec 021 §3 idempotency: scoped per booking by the unique index below, never globally. */
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
  },
  (t) => [
    // I-1: ONE payment per booking — the structural anti-double-charge guarantee, replacing the
    // baseline's non-unique index (mirrors spec 020's `bookings_offer_id_uq`).
    uniqueIndex('payments_booking_id_uq').on(t.bookingId),
    // I-2: idempotency scoped per booking, the spec 015/018/020 precedent.
    uniqueIndex('payments_booking_idempotency_key_uq').on(t.bookingId, t.idempotencyKey),
    // I-15: the sweep's access pattern.
    index('payments_protection_sweep_idx').on(t.protectionState, t.protectionWindowStartedAt),
    check(
      'payments_status_ck',
      sql`${t.status} in ('created','requires_action','authorized','captured','failed','refunded','partially_refunded')`,
    ),
    check('payments_charge_pair_ck', sql`(${t.chargeAmountMinorUnits} is null) = (${t.chargeCurrencyCode} is null)`),
    check('payments_charge_currency_format_ck', sql`${t.chargeCurrencyCode} is null or ${t.chargeCurrencyCode} ~ '^[A-Z]{3}$'`),
    check('payments_charge_positive_ck', sql`${t.chargeAmountMinorUnits} > 0`),
    // I-4: a protection state without a start instant is meaningless.
    check('payments_protection_pairing_ck', sql`(${t.protectionState} is null) = (${t.protectionWindowStartedAt} is null)`),
    // I-5: nothing is protected that was never captured (AC-5).
    check(
      'payments_protection_requires_capture_ck',
      sql`${t.protectionState} is null or ${t.status} in ('captured','refunded','partially_refunded')`,
    ),
    // I-6: a configurable window, bounded.
    check('payments_protection_window_hours_ck', sql`${t.protectionWindowHours} between 1 and 720`),
  ],
);

/**
 * Spec 021 §4 — the append-only audit trail behind every provider round trip, success or failure.
 * `payment_attempts_append_only_trg` (migration 0017) makes "what the provider said" unrewritable.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['succeeded', 'failed', 'requires_action'] }).notNull(),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    providerReference: text('provider_reference'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_attempts_payment_id_idx').on(t.paymentId),
    index('payment_attempts_payment_attempted_at_idx').on(t.paymentId, t.attemptedAt),
    check('payment_attempts_status_ck', sql`${t.status} in ('succeeded','failed','requires_action')`),
  ],
);

/** Spec 021 §4 — one row per provider authorization, carrying its capture when it happens. */
export const paymentAuthorizations = pgTable(
  'payment_authorizations',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    ...moneyColumns('authorized'),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }).notNull(),
    ...moneyColumns('captured'),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    providerReference: text('provider_reference').notNull(),
  },
  (t) => [
    index('payment_authorizations_payment_id_idx').on(t.paymentId),
    check(
      'payment_authorizations_authorized_pair_ck',
      sql`(${t.authorizedAmountMinorUnits} is null) = (${t.authorizedCurrencyCode} is null)`,
    ),
    check('payment_authorizations_authorized_positive_ck', sql`${t.authorizedAmountMinorUnits} > 0`),
    // I-9: all three capture columns null, or all three set.
    check(
      'payment_authorizations_captured_pair_ck',
      sql`(${t.capturedAmountMinorUnits} is null) = (${t.capturedCurrencyCode} is null)
          and (${t.capturedAmountMinorUnits} is null) = (${t.capturedAt} is null)`,
    ),
    // I-9: a capture can never exceed its authorization.
    check(
      'payment_authorizations_capture_not_over_ck',
      sql`${t.capturedAmountMinorUnits} is null or ${t.capturedAmountMinorUnits} <= ${t.authorizedAmountMinorUnits}`,
    ),
  ],
);

/**
 * Spec 021 §4 — the ONLY table this spec creates. Everything else is a baseline skeleton it alters.
 *
 * A price adjustment is spec 021's own entity, never an edit to the agreed booking price: spec 020
 * owns `bookings.price_amount_minor_units` and `bookings_terms_immutable_trg` forbids rewriting it.
 */
export const priceAdjustments = pgTable(
  'price_adjustments',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    /** Set only once the adjustment has actually been charged (I-14). */
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
    ...moneyColumns('additional'),
    reason: text('reason').notNull(),
    status: text('status', { enum: PRICE_ADJUSTMENT_STATUSES }).notNull(),
    proposedByUserId: uuid('proposed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
  },
  (t) => [
    index('price_adjustments_booking_id_idx').on(t.bookingId),
    index('price_adjustments_payment_id_idx').on(t.paymentId),
    index('price_adjustments_proposed_by_user_id_idx').on(t.proposedByUserId),
    index('price_adjustments_approved_by_user_id_idx').on(t.approvedByUserId),
    uniqueIndex('price_adjustments_booking_idempotency_key_uq').on(t.bookingId, t.idempotencyKey),
    check('price_adjustments_status_ck', sql`${t.status} in ('pending_approval','approved','rejected','charged','failed')`),
    check(
      'price_adjustments_amount_pair_ck',
      sql`(${t.additionalAmountMinorUnits} is null) = (${t.additionalCurrencyCode} is null)`,
    ),
    check('price_adjustments_amount_positive_ck', sql`${t.additionalAmountMinorUnits} > 0`),
    check(
      'price_adjustments_currency_format_ck',
      sql`${t.additionalCurrencyCode} is null or ${t.additionalCurrencyCode} ~ '^[A-Z]{3}$'`,
    ),
    // I-11: an approved or charged adjustment always has a named approver AND an instant.
    check('price_adjustments_approval_pairing_ck', sql`(${t.approvedByUserId} is null) = (${t.approvedAt} is null)`),
    check(
      'price_adjustments_approved_requires_instant_ck',
      sql`${t.status} not in ('approved','charged') or ${t.approvedAt} is not null`,
    ),
    // I-14: a charged adjustment always points at the payment that carried it.
    check('price_adjustments_charged_requires_payment_ck', sql`${t.status} <> 'charged' or ${t.paymentId} is not null`),
  ],
);

/** Spec 022 §3 "Refund lifecycle". `requested`/`processing` in-flight; `completed`/`failed` terminal. */
export const REFUND_STATUSES = ['requested', 'processing', 'completed', 'failed'] as const;

/** Spec 022 §3 "Reconciliation seam" — spec 022 only ever writes `pending`; `reconciled` is 024's. */
export const REFUND_RECONCILIATION_STATES = ['pending', 'reconciled'] as const;

export const REFUND_SOURCES = ['policy', 'admin_override'] as const;

/**
 * Spec 022 §4 — the baseline `refunds` skeleton, now carrying this spec's feature columns.
 *
 * ALTERED, never recreated: spec 003 already ships this table, its FK and its index.
 * `0018_add_refunds.sql` adds the columns below and attaches spec 003's EXISTING
 * `enforce_status_transition()` function via a new `refunds_status_transitions` lookup table.
 */
export const refunds = pgTable(
  'refunds',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    /** Spec 022 §4 — feature columns. The table itself is spec 003's baseline skeleton. */
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    status: text('status', { enum: REFUND_STATUSES }).notNull(),
    ...moneyColumns('total'),
    source: text('source', { enum: REFUND_SOURCES }).notNull(),
    isOverride: boolean('is_override').notNull().default(false),
    /** Null for a system-initiated policy refund; the acting user otherwise. */
    initiatedByUserId: uuid('initiated_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Spec 009's approval chain. Non-null exactly when `is_override` (C-5). */
    adminActionId: uuid('admin_action_id').references(() => adminActions.id, { onDelete: 'restrict' }),
    /** Spec 023's opaque decision handle, stored for audit. Never interpreted here. */
    eligibilityDecisionRef: text('eligibility_decision_ref'),
    /** The payment's provider handle, copied at execution time. Server-side only. */
    providerReference: text('provider_reference'),
    /** The provider's handle for THIS refund. Null until the provider issues one. */
    refundReference: text('refund_reference'),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    /** Spec 022 §3 idempotency: scoped per payment by the unique index below, never globally. */
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyFingerprint: text('idempotency_fingerprint').notNull(),
    reconciliationState: text('reconciliation_state', { enum: REFUND_RECONCILIATION_STATES }).notNull().default('pending'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('refunds_payment_id_idx').on(t.paymentId),
    index('refunds_booking_id_idx').on(t.bookingId),
    index('refunds_status_idx').on(t.status),
    index('refunds_initiated_by_user_id_idx').on(t.initiatedByUserId),
    index('refunds_admin_action_id_idx').on(t.adminActionId),
    // C-12: the index spec 024's reconciliation consumer reads.
    index('refunds_reconciliation_idx').on(t.reconciliationState, t.completedAt),
    // C-1 / AC-8: one refund per idempotency key, scoped per payment.
    uniqueIndex('refunds_payment_idempotency_key_uq').on(t.paymentId, t.idempotencyKey),
    check('refunds_status_ck', sql`${t.status} in ('requested','processing','completed','failed')`),
    check('refunds_source_ck', sql`${t.source} in ('policy','admin_override')`),
    check('refunds_reconciliation_state_ck', sql`${t.reconciliationState} in ('pending','reconciled')`),
    check('refunds_total_pair_ck', sql`(${t.totalAmountMinorUnits} is null) = (${t.totalCurrencyCode} is null)`),
    check('refunds_total_currency_format_ck', sql`${t.totalCurrencyCode} is null or ${t.totalCurrencyCode} ~ '^[A-Z]{3}$'`),
    // I-3 / I-4: no zero, no negative.
    check('refunds_total_positive_ck', sql`${t.totalAmountMinorUnits} > 0`),
    // C-5: an override is always traceable to its approval chain.
    check(
      'refunds_override_pairing_ck',
      sql`(${t.isOverride} = true) = (${t.adminActionId} is not null)
          and (${t.isOverride} = true) = (${t.source} = 'admin_override')`,
    ),
    // C-6: a completed refund always has its instant.
    check('refunds_completed_pairing_ck', sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
    // C-7: nothing unreconcilable is marked reconciled.
    check(
      'refunds_reconciled_pairing_ck',
      sql`(${t.reconciliationState} = 'reconciled') = (${t.reconciledAt} is not null)
          and (${t.reconciliationState} <> 'reconciled' or ${t.status} = 'completed')`,
    ),
    // C-8: failure detail only on failures.
    check('refunds_failure_pairing_ck', sql`${t.failureCode} is null or ${t.status} = 'failed'`),
  ],
);

/**
 * Spec 022 §4 — the immutable explanation of a refund's amount.
 *
 * Lines belong to exactly ONE refund (one refund record = one execution attempt = one provider
 * call). Multiple partial refunds against a payment are multiple `refunds` rows, each with its own
 * lines. `refund_lines_append_only_trg` makes the recorded reason unrewritable (AC-2).
 */
export const refundLines = pgTable(
  'refund_lines',
  {
    ...baseColumns(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
    ...moneyColumns('line'),
    reason: text('reason').notNull(),
  },
  (t) => [
    index('refund_lines_refund_id_idx').on(t.refundId),
    check('refund_lines_amount_pair_ck', sql`(${t.lineAmountMinorUnits} is null) = (${t.lineCurrencyCode} is null)`),
    check('refund_lines_amount_positive_ck', sql`${t.lineAmountMinorUnits} > 0`),
    check('refund_lines_currency_format_ck', sql`${t.lineCurrencyCode} is null or ${t.lineCurrencyCode} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * Spec 022 §4 / C-9 — the attribution record behind every refund transition. Append-only at the
 * database, so "who refunded this, when, and why" can never be rewritten.
 */
export const refundsStatusHistory = pgTable(
  'refunds_status_history',
  {
    ...baseColumns(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    actorRole: text('actor_role', { enum: ['customer', 'provider', 'admin', 'system'] }).notNull(),
    detail: text('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refunds_status_history_refund_id_idx').on(t.refundId),
    index('refunds_status_history_actor_user_id_idx').on(t.actorUserId),
    check('refunds_status_history_actor_role_ck', sql`${t.actorRole} in ('customer','provider','admin','system')`),
    // C-9: a real user unless the actor is the system (the reconcile sweep).
    check('refunds_status_history_actor_pairing_ck', sql`(${t.actorUserId} is null) = (${t.actorRole} = 'system')`),
  ],
);

/**
 * Spec 022 §4 — the lookup table spec 003's EXISTING `enforce_status_transition()` function derives
 * by name (`<table>_status_transitions`). Creating it and attaching the trigger is what puts
 * `refunds` under the same enforcement the other five state-machine tables already have, without
 * writing a new trigger function.
 */
export const refundsStatusTransitions = pgTable(
  'refunds_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('refunds_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

export const payouts = pgTable(
  'payouts',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
  },
  (t) => [index('payouts_provider_profile_id_idx').on(t.providerProfileId)],
);

export const payoutMethods = pgTable(
  'payout_methods',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
  },
  (t) => [index('payout_methods_provider_profile_id_idx').on(t.providerProfileId)],
);

export const paymentsStatusHistory = pgTable(
  'payments_status_history',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Spec 021 §4 I-7 — added for the same reason spec 020 added it to `bookings_status_history`:
     * `actor_user_id` is nullable for this spec's `system` (sweep) transitions, so attribution
     * needs its own column to stay provable.
     */
    actorRole: text('actor_role', { enum: ['customer', 'provider', 'system', 'admin'] }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_status_history_payment_id_idx').on(t.paymentId),
    index('payments_status_history_actor_user_id_idx').on(t.actorUserId),
    check('payments_status_history_actor_role_ck', sql`${t.actorRole} in ('customer','provider','system','admin')`),
    // I-7: a real user unless the actor is the system (spec 021's sweep transitions).
    check('payments_status_history_actor_pairing_ck', sql`(${t.actorUserId} is null) = (${t.actorRole} = 'system')`),
  ],
);

export const paymentsStatusTransitions = pgTable(
  'payments_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('payments_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

export const payoutsStatusHistory = pgTable(
  'payouts_status_history',
  {
    ...baseColumns(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payouts_status_history_payout_id_idx').on(t.payoutId),
    index('payouts_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const payoutsStatusTransitions = pgTable(
  'payouts_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('payouts_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    ...baseColumns(),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'restrict' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('conversations_request_id_idx').on(t.requestId),
    index('conversations_booking_id_idx').on(t.bookingId),
  ],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    ...baseColumns(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('conversation_participants_conversation_id_idx').on(t.conversationId),
    index('conversation_participants_user_id_idx').on(t.userId),
    uniqueIndex('conversation_participants_conversation_user_uq').on(t.conversationId, t.userId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    ...baseColumns(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('messages_conversation_id_idx').on(t.conversationId),
    index('messages_sender_user_id_idx').on(t.senderUserId),
  ],
);

export const messageAttachments = pgTable(
  'message_attachments',
  {
    ...baseColumns(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
  },
  (t) => [index('message_attachments_message_id_idx').on(t.messageId)],
);

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const reviews = pgTable(
  'reviews',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('reviews_booking_id_idx').on(t.bookingId), index('reviews_author_user_id_idx').on(t.authorUserId)],
);

export const reviewResponses = pgTable(
  'review_responses',
  {
    ...baseColumns(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    responderUserId: uuid('responder_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('review_responses_review_id_idx').on(t.reviewId),
    index('review_responses_responder_user_id_idx').on(t.responderUserId),
  ],
);

export const reviewReports = pgTable(
  'review_reports',
  {
    ...baseColumns(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('review_reports_review_id_idx').on(t.reviewId),
    index('review_reports_reporter_user_id_idx').on(t.reporterUserId),
  ],
);

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export const disputes = pgTable(
  'disputes',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    openedByUserId: uuid('opened_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('disputes_booking_id_idx').on(t.bookingId),
    index('disputes_opened_by_user_id_idx').on(t.openedByUserId),
  ],
);

export const disputeEvidence = pgTable(
  'dispute_evidence',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    submittedByUserId: uuid('submitted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('dispute_evidence_dispute_id_idx').on(t.disputeId),
    index('dispute_evidence_submitted_by_user_id_idx').on(t.submittedByUserId),
  ],
);

export const disputeMessages = pgTable(
  'dispute_messages',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('dispute_messages_dispute_id_idx').on(t.disputeId),
    index('dispute_messages_sender_user_id_idx').on(t.senderUserId),
  ],
);

export const disputeResolutions = pgTable(
  'dispute_resolutions',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
  },
  (t) => [index('dispute_resolutions_dispute_id_idx').on(t.disputeId)],
);

export const disputeAppeals = pgTable(
  'dispute_appeals',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    appellantUserId: uuid('appellant_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('dispute_appeals_dispute_id_idx').on(t.disputeId),
    index('dispute_appeals_appellant_user_id_idx').on(t.appellantUserId),
  ],
);

// ---------------------------------------------------------------------------
// Support & safety
// ---------------------------------------------------------------------------

export const safetyReports = pgTable(
  'safety_reports',
  {
    ...baseColumns(),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('safety_reports_reporter_user_id_idx').on(t.reporterUserId),
    index('safety_reports_booking_id_idx').on(t.bookingId),
  ],
);

export const supportTickets = pgTable(
  'support_tickets',
  {
    ...baseColumns(),
    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('support_tickets_requester_user_id_idx').on(t.requesterUserId)],
);

export const supportMessages = pgTable(
  'support_messages',
  {
    ...baseColumns(),
    supportTicketId: uuid('support_ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('support_messages_support_ticket_id_idx').on(t.supportTicketId),
    index('support_messages_sender_user_id_idx').on(t.senderUserId),
  ],
);

export const supportNotes = pgTable(
  'support_notes',
  {
    ...baseColumns(),
    supportTicketId: uuid('support_ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('support_notes_support_ticket_id_idx').on(t.supportTicketId),
    index('support_notes_author_user_id_idx').on(t.authorUserId),
  ],
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    ...baseColumns(),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('notifications_recipient_user_id_idx').on(t.recipientUserId)],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('notification_preferences_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export const aiConversations = pgTable(
  'ai_conversations',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_conversations_user_id_idx').on(t.userId)],
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    ...baseColumns(),
    aiConversationId: uuid('ai_conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_messages_ai_conversation_id_idx').on(t.aiConversationId)],
);

export const aiMemories = pgTable(
  'ai_memories',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_memories_user_id_idx').on(t.userId)],
);

export const aiActions = pgTable(
  'ai_actions',
  {
    ...baseColumns(),
    aiConversationId: uuid('ai_conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_actions_ai_conversation_id_idx').on(t.aiConversationId)],
);

export const aiToolCalls = pgTable(
  'ai_tool_calls',
  {
    ...baseColumns(),
    aiActionId: uuid('ai_action_id')
      .notNull()
      .references(() => aiActions.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_tool_calls_ai_action_id_idx').on(t.aiActionId)],
);

// ---------------------------------------------------------------------------
// Platform / admin
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    ...baseColumns(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('audit_logs_actor_user_id_idx').on(t.actorUserId)],
);

export const featureFlags = pgTable('feature_flags', { ...baseColumns() });

export const policies = pgTable('policies', { ...baseColumns() });

export const policyVersions = pgTable(
  'policy_versions',
  {
    ...baseColumns(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'restrict' }),
  },
  (t) => [index('policy_versions_policy_id_idx').on(t.policyId)],
);

export const policyAcceptances = pgTable(
  'policy_acceptances',
  {
    ...baseColumns(),
    policyVersionId: uuid('policy_version_id')
      .notNull()
      .references(() => policyVersions.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('policy_acceptances_policy_version_id_idx').on(t.policyVersionId),
    index('policy_acceptances_user_id_idx').on(t.userId),
    uniqueIndex('policy_acceptances_policy_version_user_uq').on(t.policyVersionId, t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Security, files, location, analytics
// ---------------------------------------------------------------------------

/** Spec 005 §4/§8 risk #3: adds lifetime/refresh/revocation columns to this spec 003 baseline table. */
export const sessions = pgTable(
  'sessions',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    mfaSatisfied: boolean('mfa_satisfied').notNull().default(false),
    deviceLabel: text('device_label'),
    ipHash: text('ip_hash'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Spec 006 §4: the CURRENT SESSION's active mode — never a global `User` preference. */
    activeMode: text('active_mode', { enum: ['customer', 'provider'] }).notNull().default('customer'),
    /** Spec 008 §4/AC-1/AC-2: why this session was revoked (e.g. `user_logout_all_devices`,
     * `user_logout_single_device`) — null for a session that was never revoked. */
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    check('sessions_active_mode_ck', sql`${t.activeMode} in ('customer','provider')`),
  ],
);

/** Spec 005 §4/AC-2: adds the columns needed to actually record a security event. */
export const securityEvents = pgTable(
  'security_events',
  {
    ...baseColumns(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    severity: text('severity').notNull(),
    metadata: jsonb('metadata'),
  },
  (t) => [index('security_events_user_id_idx').on(t.userId)],
);

/**
 * Spec 027 owns FileAsset's real columns (`kind`, `visibility`, `storage_key`, `size_bytes`,
 * `status`, `context_type`, `context_id`, ...) and its storage backend — neither implemented yet,
 * so this stays exactly spec 003's baseline shape. Spec 008 (data export, lib/privacy/export.ts)
 * inserts a bare reference row here per export and depends on spec 027's storage capability
 * (lib/privacy/file-asset-storage.ts — a contract spec 008 consumes, not implements) for the
 * actual generated bytes, rather than adding a bespoke content column to this shared table.
 */
export const fileAssets = pgTable(
  'file_assets',
  {
    ...baseColumns(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('file_assets_uploaded_by_user_id_idx').on(t.uploadedByUserId)],
);

/**
 * Spec 012 §4 owns `locations`'/`addresses`' real columns; this stays exactly spec 003's baseline
 * shape until then. Coordinates are fixed-point integers (degrees × 1,000,000), never
 * numeric/real/double — schema-lint AC-1 bans float types schema-wide, and this mirrors
 * `moneyColumns()`'s minor-units approach at six decimal places of precision instead of currency.
 */
export const locations = pgTable(
  'locations',
  {
    ...baseColumns(),
    latitudeMicroDegrees: integer('latitude_micro_degrees'),
    longitudeMicroDegrees: integer('longitude_micro_degrees'),
    geoHierarchy: jsonb('geo_hierarchy'),
  },
  (t) => [
    check(
      'locations_lat_lng_pair_ck',
      sql`(${t.latitudeMicroDegrees} is null) = (${t.longitudeMicroDegrees} is null)`,
    ),
    check(
      'locations_latitude_range_ck',
      sql`${t.latitudeMicroDegrees} is null or ${t.latitudeMicroDegrees} between -90000000 and 90000000`,
    ),
    check(
      'locations_longitude_range_ck',
      sql`${t.longitudeMicroDegrees} is null or ${t.longitudeMicroDegrees} between -180000000 and 180000000`,
    ),
  ],
);

export const addresses = pgTable(
  'addresses',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    structured: jsonb('structured').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [index('addresses_user_id_idx').on(t.userId), index('addresses_location_id_idx').on(t.locationId)],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    ...baseColumns(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('analytics_events_actor_user_id_idx').on(t.actorUserId)],
);

/**
 * Spec 013 §4 — the caller's own recent searches, sourcing `/api/v1/search/autocomplete`'s
 * AC-2 "recent searches" suggestion. Deliberately a dedicated table, not a reuse of
 * `analyticsEvents` (still column-less; spec 040 owns adding its real columns) — an analytics
 * log is the wrong shape for a low-latency, per-user, autocomplete-facing read path.
 */
export const recentSearches = pgTable(
  'recent_searches',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    q: text('q'),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('recent_searches_user_id_idx').on(t.userId),
    index('recent_searches_service_id_idx').on(t.serviceId),
    index('recent_searches_category_id_idx').on(t.categoryId),
  ],
);
