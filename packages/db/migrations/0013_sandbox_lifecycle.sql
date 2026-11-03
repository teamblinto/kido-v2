CREATE TYPE "public"."sandbox_pool_state" AS ENUM('creating', 'ready', 'releasing');--> statement-breakpoint
CREATE TYPE "public"."sandbox_transition" AS ENUM('creating', 'resuming', 'hibernating', 'releasing');--> statement-breakpoint
CREATE TABLE "sandbox_pool" (
	"daytona_id" text NOT NULL,
	"failure_reason" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node" text,
	"ready_at" timestamp with time zone,
	"snapshot" text NOT NULL,
	"state" "sandbox_pool_state" DEFAULT 'creating' NOT NULL,
	"template" text NOT NULL,
	"workspace_root" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_pool_daytona_id_unique" UNIQUE("daytona_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_pool_settings" (
	"snapshot" text,
	"target_depth" integer NOT NULL,
	"template" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ALTER COLUMN "workspace_root" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "state_entered_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "transition" "sandbox_transition";--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "transition_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sandbox_pool_template_state_ready_at_idx" ON "sandbox_pool" USING btree ("template","state","ready_at");--> statement-breakpoint
CREATE INDEX "outbox_type_aggregate_id_idx" ON "outbox" USING btree ("type","aggregate_id");