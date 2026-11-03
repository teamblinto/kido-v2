CREATE TYPE "public"."connector_account_type" AS ENUM('organization', 'user');--> statement-breakpoint
CREATE TYPE "public"."connector_health" AS ENUM('healthy', 'needs_reauth', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."connector_provider" AS ENUM('github');--> statement-breakpoint
CREATE TYPE "public"."repo_link_state" AS ENUM('linked', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."sync_failure_reason" AS ENUM('remote-ahead', 'diverged', 'nothing-to-push', 'run-active', 'operation-in-flight', 'needs-reauth', 'provider-unavailable', 'not-linked', 'create-unsupported', 'name-taken', 'timed-out', 'git-failed', 'bundle-too-large');--> statement-breakpoint
CREATE TYPE "public"."sync_kind" AS ENUM('push', 'pull');--> statement-breakpoint
CREATE TYPE "public"."sync_state" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
ALTER TYPE "public"."checkpoint_kind" ADD VALUE 'pull';--> statement-breakpoint
CREATE TABLE "connections" (
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" "connector_account_type" NOT NULL,
	"circuit_open_until" timestamp with time zone,
	"connected_by" uuid NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"health" "connector_health" NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"last_verified_at" timestamp with time zone,
	"org_id" uuid NOT NULL,
	"provider" "connector_provider" NOT NULL,
	"secret_id" uuid,
	"token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "connections_org_id_provider_key" UNIQUE("org_id","provider")
);
--> statement-breakpoint
CREATE TABLE "repo_links" (
	"branch" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_pushed_checkpoint_id" uuid,
	"linked_by" uuid NOT NULL,
	"name" text NOT NULL,
	"org_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"project_id" uuid NOT NULL,
	"remote_head_sha" text,
	"repo_id" bigint NOT NULL,
	"state" "repo_link_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_links_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "repo_links_org_id_project_id_key" UNIQUE("org_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "sync_operations" (
	"commits" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"from_sha" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "sync_kind" NOT NULL,
	"link_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"reason" "sync_failure_reason",
	"requested_by" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"state" "sync_state" NOT NULL,
	"to_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_operations_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "sync_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_secret_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "public"."secrets"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_org_id_project_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_org_id_connection_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_org_id_last_pushed_checkpoint_id_fk" FOREIGN KEY ("org_id","last_pushed_checkpoint_id") REFERENCES "public"."checkpoints"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_org_id_project_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_org_id_link_id_fk" FOREIGN KEY ("org_id","link_id") REFERENCES "public"."repo_links"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_operations_one_in_flight" ON "sync_operations" USING btree ("org_id","project_id") WHERE "sync_operations"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "sync_operations_org_project_created_idx" ON "sync_operations" USING btree ("org_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_org_id_sync_operation_id_fk" FOREIGN KEY ("org_id","sync_operation_id") REFERENCES "public"."sync_operations"("org_id","id") ON DELETE no action ON UPDATE no action;
