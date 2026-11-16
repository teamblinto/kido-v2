-- Row-level security and privileges for the two tables 0061 created (spec 048).
--
-- Hand-written for the reason 0003, 0009, 0016, 0028 and 0048 give: a policy and a grant belong
-- with the schema that creates the table and drizzle-kit emits neither.
--
-- Both tables are tenant-owned and get the §09 shape every tenant table has. An upload, a link, a
-- download and a pending delete all run in the request's tenant transaction. The 24-hour sweep of
-- pending files finds candidates across tenants through forge_bypass, which reads only, as
-- everywhere (0003), and deletes each one inside that file's own tenant transaction.

ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachments" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "attachments"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "attachments" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "attachments" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "run_message_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_message_attachments" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "run_message_attachments"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "run_message_attachments" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "run_message_attachments" TO "forge_bypass";
