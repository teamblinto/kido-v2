CREATE TABLE "project_invitations" (
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"email" "citext" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invited_by" uuid,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"role" "project_role" NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_invitations_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "project_invitations_accepted_or_revoked_check" CHECK (not ("project_invitations"."accepted_at" is not null and "project_invitations"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_org_id_project_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_token_hash_key" ON "project_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_open_key" ON "project_invitations" USING btree ("org_id","project_id","email") WHERE "project_invitations"."accepted_at" is null and "project_invitations"."revoked_at" is null;