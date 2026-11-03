CREATE TYPE "public"."template_version_state" AS ENUM('building', 'ready', 'failed', 'retired');--> statement-breakpoint
CREATE TABLE "template_versions" (
	"created_at" timestamp with time zone NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	"digest" text NOT NULL,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"ready_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"snapshot" text NOT NULL,
	"state" "template_version_state" DEFAULT 'building' NOT NULL,
	"template" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "template_versions_pk" PRIMARY KEY("template","digest"),
	CONSTRAINT "template_versions_snapshot_key" UNIQUE("snapshot")
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "template_snapshot" text;--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_current_idx" ON "template_versions" USING btree ("template") WHERE "template_versions"."current";--> statement-breakpoint
ALTER TABLE "sandbox_pool_settings" DROP COLUMN "snapshot";