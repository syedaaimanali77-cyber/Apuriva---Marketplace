import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema';

/**
 * Spec 003 AC-4: every entity in master spec §124, plus the five status-history and five
 * status-transition tables, exists as a baseline table — plus, from spec 009 onward, any table a
 * later spec's own data model legitimately adds beyond §124's minimum list (§124: "design entities
 * for, at minimum").
 */
const EXPECTED_TABLES = [
  // Identity & access
  'users',
  'customer_profiles',
  'provider_profiles',
  'admin_profiles',
  'roles',
  'permissions',
  // Spec 009 §4: not in master spec §124's minimum list — added for the RBAC approval framework
  // (admin/role many-to-many, and the risk-tiered approval workflow record + its decisions).
  'admin_role_assignments',
  'admin_actions',
  'admin_action_approvals',
  // Catalog
  'categories',
  'subcategories',
  'services',
  'service_fields',
  'service_requirements',
  'service_faqs',
  'service_packages',
  // Provider catalog & availability
  'provider_services',
  'provider_availabilities',
  'provider_availability_overrides',
  'provider_service_areas',
  // Spec 016 §4 / AC-6: not in master spec §124's minimum list — added for the customer's
  // availability-notification opt-in, the same allowance spec 009 used for `admin_role_assignments`.
  'provider_availability_notification_requests',
  // Requests
  'requests',
  'request_field_values',
  'request_attachments',
  'request_provider_matches',
  'requests_status_history',
  'requests_status_transitions',
  // Offers
  'offers',
  'offer_revisions',
  'offer_messages',
  'offers_status_history',
  'offers_status_transitions',
  // Bookings
  'bookings',
  'booking_milestones',
  'bookings_status_history',
  'bookings_status_transitions',
  // Payments & payouts
  'payments',
  'payment_attempts',
  'payment_authorizations',
  'refunds',
  'refund_lines',
  'payouts',
  'payout_methods',
  'payments_status_history',
  'payments_status_transitions',
  'payouts_status_history',
  'payouts_status_transitions',
  // Messaging
  'conversations',
  'conversation_participants',
  'messages',
  'message_attachments',
  // Reviews
  'reviews',
  'review_responses',
  'review_reports',
  // Disputes
  'disputes',
  'dispute_evidence',
  'dispute_messages',
  'dispute_resolutions',
  'dispute_appeals',
  // Support & safety
  'safety_reports',
  'support_tickets',
  'support_messages',
  'support_notes',
  // Notifications
  'notifications',
  'notification_preferences',
  // AI
  'ai_conversations',
  'ai_messages',
  'ai_memories',
  'ai_actions',
  'ai_tool_calls',
  // Platform / admin
  'audit_logs',
  'feature_flags',
  'policies',
  'policy_versions',
  'policy_acceptances',
  // Security, files, location, analytics
  'sessions',
  'security_events',
  'file_assets',
  'locations',
  'addresses',
  'analytics_events',
  'recent_searches',
] as const;

const STATE_MACHINE_ENTITIES = ['requests', 'offers', 'bookings', 'payments', 'payouts'] as const;

function schemaTableNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      names.add(getTableName(value));
    }
  }
  return names;
}

describe('schema coverage (spec 003 AC-4)', () => {
  const tableNames = schemaTableNames();

  it.each(EXPECTED_TABLES)('table "%s" exists in the baseline schema', (name) => {
    expect(tableNames.has(name)).toBe(true);
  });

  it('has exactly the expected set of tables — nothing missing, nothing extra', () => {
    expect([...tableNames].sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it.each(STATE_MACHINE_ENTITIES)('%s has both a status-history and a status-transitions table', (entity) => {
    expect(tableNames.has(`${entity}_status_history`)).toBe(true);
    expect(tableNames.has(`${entity}_status_transitions`)).toBe(true);
  });
});
