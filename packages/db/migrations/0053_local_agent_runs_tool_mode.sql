ALTER TABLE "local_agent_runs" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "local_agent_runs" ADD COLUMN "tool_mode" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_workspace_check" CHECK (("local_agent_runs"."tool_mode" = 'workspace') = ("local_agent_runs"."workspace_id" is not null));