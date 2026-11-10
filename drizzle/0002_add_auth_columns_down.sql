-- Down migration for 0002_add_auth_columns —
-- docs/specs/2026-08-28-005-authentication.md (spec 005).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0002_add_auth_columns added, in reverse order, and nothing else.
--
-- Dropping these columns destroys every credential, session and security event written since 0002.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_unique";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_number_unique";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_verified_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email";
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_number";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "revoked_at";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "ip_hash";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "device_label";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "mfa_satisfied";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "expires_at";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "issued_at";
ALTER TABLE "security_events" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "security_events" DROP COLUMN IF EXISTS "severity";
ALTER TABLE "security_events" DROP COLUMN IF EXISTS "event_type";
ALTER TABLE "admin_profiles" DROP COLUMN IF EXISTS "mfa_enrolled_at";
ALTER TABLE "admin_profiles" DROP COLUMN IF EXISTS "totp_secret_encrypted";
