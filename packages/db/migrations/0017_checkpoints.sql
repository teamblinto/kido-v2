CREATE TYPE "public"."checkpoint_kind" AS ENUM('baseline', 'turn', 'revert');--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"actor_id" uuid,
	"files" jsonb NOT NULL,
	"git_sha" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "checkpoint_kind" NOT NULL,
	"label" text NOT NULL,
	"mirrored_at" timestamp with time zone,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"project_id" uuid NOT NULL,
	"reverts_id" uuid,
	"run_id" uuid,
	"turn" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoints_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "checkpoints_org_id_project_id_git_sha_key" UNIQUE("org_id","project_id","git_sha"),
	CONSTRAINT "checkpoints_baseline_check" CHECK (("checkpoints"."kind" = 'baseline') = ("checkpoints"."parent_id" is null)),
	CONSTRAINT "checkpoints_turn_check" CHECK (("checkpoints"."kind" = 'turn') = ("checkpoints"."run_id" is not null and "checkpoints"."turn" is not null)),
	CONSTRAINT "checkpoints_revert_check" CHECK (("checkpoints"."kind" = 'revert') = ("checkpoints"."actor_id" is not null and "checkpoints"."reverts_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_org_id_project_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_org_id_parent_id_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "public"."checkpoints"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_org_id_reverts_id_fk" FOREIGN KEY ("org_id","reverts_id") REFERENCES "public"."checkpoints"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkpoints_org_project_created_idx" ON "checkpoints" USING btree ("org_id","project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);