CREATE TYPE "public"."credential_mode" AS ENUM('PLATFORM', 'BYOK', 'BYOS');--> statement-breakpoint
CREATE TYPE "public"."run_failure_class" AS ENUM('executor', 'tool_error', 'stalled', 'cancelled_by_system', 'internal');--> statement-breakpoint
CREATE TYPE "public"."run_message_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'starting', 'running', 'awaiting_input', 'tool_error', 'paused', 'cancelled', 'failed', 'succeeded');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"cancel_requested_at" timestamp with time zone,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"credential_mode" "credential_mode" DEFAULT 'PLATFORM' NOT NULL,
	"ended_at" timestamp with time zone,
	"failure_class" "run_failure_class",
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"model" text NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"org_id" uuid NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"project_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "run_messages" (
	"at" timestamp with time zone NOT NULL,
	"content" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "run_message_role" NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_messages_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_project_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_org_id_run_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."agent_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_org_id_project_id_created_at_idx" ON "agent_runs" USING btree ("org_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_status_lease_until_idx" ON "agent_runs" USING btree ("status","lease_until") WHERE "agent_runs"."lease_until" is not null;--> statement-breakpoint
CREATE INDEX "run_messages_org_id_run_id_at_idx" ON "run_messages" USING btree ("org_id","run_id","at");--> statement-breakpoint

-- Row-level security and privileges for the two conventional run tables (spec 008, §09).
--
-- Hand-written below the generated DDL for the reason 0002 and 0006 give: drizzle-kit diffs
-- tables, keys and indexes, and a policy or a grant is none of those. Same file as the tables so
-- the gate in `src/schema/rls.spec.ts` never sees a tenant-owned table without its policy.
-- `run_events` is not here: it is partitioned, and 0011 creates it whole.
--
-- ENABLE and FORCE, both, with 0004's NULLIF predicate on both clauses.

ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_runs" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_runs"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "run_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_messages" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "run_messages"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Privileges, per 0003: forge_app writes both on the request and worker paths; forge_bypass
-- reads for exports and rollups and gets no UPDATE and no DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_runs"   TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "run_messages" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "agent_runs"   TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "run_messages" TO "forge_bypass";
