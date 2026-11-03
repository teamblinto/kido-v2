ALTER TABLE "sync_operations" DROP CONSTRAINT "sync_operations_org_id_link_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_operations" ALTER COLUMN "link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_org_id_link_id_fk" FOREIGN KEY ("org_id","link_id") REFERENCES "public"."repo_links"("org_id","id") ON DELETE set null ON UPDATE no action;