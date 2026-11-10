-- ---------------------------------------------------------------------------
-- Spec 034 — AI Conversation, Memory & Autonomy
-- ---------------------------------------------------------------------------
-- THIS MIGRATION CREATES NO TABLE. `ai_conversations`, `ai_messages`, `ai_memories` and
-- `ai_actions` already exist as spec 003 baseline skeletons (drizzle/0001_baseline_schema.sql),
-- each carrying `baseColumns()` plus its foreign keys and nothing else. This adds their feature
-- columns. `ai_tool_calls` belongs to spec 036 and is not touched.
--
-- NO BACKFILL: nothing has ever written the four skeletons, so the new NOT NULL columns need no
-- default. The one `users` column carries its own default.
--
-- Temporary conversations and proactive suggestions need no storage (spec 034 §3.10, §3.11).

-- ---------------------------------------------------------------------------
-- users — the proactive-suggestions preference (§3.10)
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "ai_proactive_suggestions_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ai_conversations — tombstone + idempotency (§4)
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_conversations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_conversations_user_updated_at_idx" ON "ai_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_conversations_user_idempotency_key_uq" ON "ai_conversations" USING btree ("user_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ai_messages — the transcript (§4). A turn's Idempotency-Key lives on its ASSISTANT row.
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_messages" ADD COLUMN "role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "idempotency_fingerprint" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_role_ck" CHECK ("role" in ('user','assistant'));--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_idempotency_ck" CHECK (("role" = 'assistant') = ("idempotency_key" is not null) and ("idempotency_key" is null) = ("idempotency_fingerprint" is null));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_messages_conversation_created_at_id_idx" ON "ai_messages" USING btree ("ai_conversation_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_messages_conversation_idempotency_key_uq" ON "ai_messages" USING btree ("ai_conversation_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ai_memories — the CLOSED three-key allow-list (§3.9, AC-19). Provider characteristics and
-- communication preferences are deliberately absent and cannot be stored.
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_memories" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD COLUMN "value" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_key_ck" CHECK ("key" in ('preferred_category','preferred_area','language'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_memories_user_key_uq" ON "ai_memories" USING btree ("user_id","key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ai_actions — activity history (§3.4, §4). No free-text column: the label is derived at read time.
-- `risk_tier` EXCLUDES 'restricted', so a restricted action cannot be recorded even by a bug (AC-7).
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_actions" ADD COLUMN "action_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "risk_tier" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "required_confirmation" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "result" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "reversible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "related_entity_type" text;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "related_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "idempotency_fingerprint" text;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_risk_tier_ck" CHECK ("risk_tier" in ('low','medium','high'));--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_result_ck" CHECK ("result" in ('pending','succeeded','failed'));--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_related_entity_type_ck" CHECK ("related_entity_type" is null or "related_entity_type" in ('request','booking'));--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_related_pair_ck" CHECK (("related_entity_type" is null) = ("related_entity_id" is null));--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_idempotency_pair_ck" CHECK (("idempotency_key" is null) = ("idempotency_fingerprint" is null));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_actions_conversation_created_at_idx" ON "ai_actions" USING btree ("ai_conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_actions_conversation_idempotency_key_uq" ON "ai_actions" USING btree ("ai_conversation_id","idempotency_key");
