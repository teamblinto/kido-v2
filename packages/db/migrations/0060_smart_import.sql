ALTER TABLE "projects" ADD COLUMN "name_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "run_config" jsonb;