-- Down migration for 0001_baseline_schema — docs/specs/2026-08-28-003-database-core-data-model.md §4.
--
-- Drops every baseline table plus the shared status-transition trigger mechanism created by
-- 0001_baseline_schema.sql. Safe pre-launch only (no data-loss guard, no confirmation) — not a
-- promise that later migrations stay reversible. Hand-written: drizzle-kit does not generate
-- down migrations. Run via `npm run db:rollback` (lib/db/rollback.ts), never applied
-- automatically by `npm run db:migrate` (it carries no entry in drizzle/meta/_journal.json).
--
-- 0001_baseline_schema.sql itself is never edited once merged (immutability, spec 003 §4); this
-- file is its companion, not a modification of it.

DROP TRIGGER IF EXISTS payouts_status_transition_trg ON "payouts";
DROP TRIGGER IF EXISTS payments_status_transition_trg ON "payments";
DROP TRIGGER IF EXISTS bookings_status_transition_trg ON "bookings";
DROP TRIGGER IF EXISTS offers_status_transition_trg ON "offers";
DROP TRIGGER IF EXISTS requests_status_transition_trg ON "requests";

-- CASCADE handles FK-dependency ordering across all 77 baseline tables (67 core §124 entities +
-- the 5 status-history + 5 status-transition tables) in one statement, regardless of declaration order.
DROP TABLE IF EXISTS
  "addresses",
  "admin_profiles",
  "ai_actions",
  "ai_conversations",
  "ai_memories",
  "ai_messages",
  "ai_tool_calls",
  "analytics_events",
  "audit_logs",
  "booking_milestones",
  "bookings",
  "bookings_status_history",
  "bookings_status_transitions",
  "categories",
  "conversation_participants",
  "conversations",
  "customer_profiles",
  "dispute_appeals",
  "dispute_evidence",
  "dispute_messages",
  "dispute_resolutions",
  "disputes",
  "feature_flags",
  "file_assets",
  "locations",
  "message_attachments",
  "messages",
  "notification_preferences",
  "notifications",
  "offer_messages",
  "offer_revisions",
  "offers",
  "offers_status_history",
  "offers_status_transitions",
  "payment_attempts",
  "payment_authorizations",
  "payments",
  "payments_status_history",
  "payments_status_transitions",
  "payout_methods",
  "payouts",
  "payouts_status_history",
  "payouts_status_transitions",
  "permissions",
  "policies",
  "policy_acceptances",
  "policy_versions",
  "provider_availabilities",
  "provider_availability_overrides",
  "provider_profiles",
  "provider_service_areas",
  "provider_services",
  "refund_lines",
  "refunds",
  "request_attachments",
  "request_field_values",
  "request_provider_matches",
  "requests",
  "requests_status_history",
  "requests_status_transitions",
  "review_reports",
  "review_responses",
  "reviews",
  "roles",
  "safety_reports",
  "security_events",
  "service_faqs",
  "service_fields",
  "service_packages",
  "service_requirements",
  "services",
  "sessions",
  "subcategories",
  "support_messages",
  "support_notes",
  "support_tickets",
  "users"
  CASCADE;

DROP FUNCTION IF EXISTS enforce_status_transition();
