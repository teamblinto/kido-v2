CREATE TYPE "public"."sync_trigger" AS ENUM('manual', 'auto');--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'branch-protected';--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'push-rejected';--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'workflow-permission';--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'repo-gone';--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'account-mismatch';--> statement-breakpoint
-- Links that exist now stay manual: a deployment must not start pushing to repositories whose
-- owners never asked for it. New links default on. Two statements rather than an UPDATE, which
-- would have to get past repo_links' forced RLS.
ALTER TABLE "repo_links" ADD COLUMN "auto_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_links" ALTER COLUMN "auto_sync" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "repo_links" ADD COLUMN "side_branch" text;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD COLUMN "target_branch" text;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD COLUMN "trigger" "sync_trigger" DEFAULT 'manual' NOT NULL;