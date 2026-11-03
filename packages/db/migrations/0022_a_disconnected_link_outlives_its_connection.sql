ALTER TABLE "repo_links" DROP CONSTRAINT "repo_links_org_id_connection_id_fk";
--> statement-breakpoint
ALTER TABLE "repo_links" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_org_id_connection_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."connections"("org_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_links" ADD CONSTRAINT "repo_links_state_check" CHECK (("repo_links"."state" = 'linked') = ("repo_links"."connection_id" is not null));