-- sandboxes: the project's registered Daytona sandbox (spec 010, data-model.md).
--
-- drizzle-generated DDL first, then the hand-written block 0010 established: RLS enabled AND
-- forced with 0004's NULLIF predicate on both clauses, and the two role grants. The table is
-- tenant-owned in the conventional way — `unique (org_id, id)` and a composite foreign key onto
-- `projects (org_id, id)` — so a project cannot be given another tenant's sandbox and a deleted
-- project takes its row with it. `unique (org_id, project_id)` is §06's "one sandbox per
-- project"; `unique (daytona_id)` is its converse, one project per Daytona sandbox.
CREATE TYPE "public"."sandbox_state" AS ENUM('pooled', 'active', 'idle', 'hibernated', 'archived');--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"daytona_id" text NOT NULL,
	"hibernated_at" timestamp with time zone,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"node" text,
	"org_id" uuid NOT NULL,
	"ports" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot_key" text,
	"state" "sandbox_state" DEFAULT 'active' NOT NULL,
	"workspace_root" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "sandboxes_org_id_project_id_key" UNIQUE("org_id","project_id"),
	CONSTRAINT "sandboxes_daytona_id_key" UNIQUE("daytona_id")
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_org_id_project_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "sandboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandboxes" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sandboxes"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Privileges, per 0003: forge_app reads on the port and writes on registration; forge_bypass
-- reads for exports and rollups and gets no UPDATE and no DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sandboxes" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "sandboxes" TO "forge_bypass";
