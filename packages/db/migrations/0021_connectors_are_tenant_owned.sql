-- Row-level security and privileges for `connections`, `repo_links` and `sync_operations`, which
-- 0020 created (spec 018, data-model.md), plus the one CHECK 0020 could not carry.
--
-- Hand-written for the reason 0003, 0009, 0014, 0016 and 0018 give: a policy and a grant belong
-- with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policies
--
-- All three are tenant-owned — each carries `org_id` and composite FKs to `projects`, `secrets`,
-- or each other — so they get the §09 shape every tenant table has: ENABLE + FORCE (the migrator
-- owns the table and is not exempt), and both USING and WITH CHECK on `app.org_id` so a row can
-- be neither read nor written outside the transaction's tenant. `rls.spec.ts` derives the three
-- into its gate from the column and asserts exactly this.
--
-- ## Why forge_app gets all four verbs
--
-- A connection is repointed, re-verified and removed; a link is disconnected and removed; a sync
-- operation moves `queued → running → succeeded | failed`. None is history in FR-003's sense
-- (`checkpoints` is, and stays column-scoped by 0018); `sync_operations` is append-only by
-- convention, not by grant, because its state column must change. forge_bypass reads for exports
-- and, as everywhere (0003), gets no UPDATE and no DELETE.
--
-- ## Why `checkpoints_pull_check` is here and not in 0020
--
-- 0020 adds `'pull'` to `checkpoint_kind`, and Postgres refuses to *use* a new enum value in the
-- transaction that added it ("unsafe use of new value"). drizzle-kit applies every *pending*
-- migration in one transaction, so on an empty database 0020 and this file share a transaction
-- and even a later file cannot name the value as an enum literal. Comparing `kind::text` never
-- looks the label up in `pg_enum`, so the CHECK is safe either way and means the same thing. The
-- snapshot already records it, so drizzle-kit will not diff it again.

ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connections" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connections"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "repo_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repo_links" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "repo_links"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "sync_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_operations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sync_operations"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "connections"     TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "repo_links"      TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sync_operations" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "connections"     TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "repo_links"      TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "sync_operations" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_pull_check"
  CHECK ((kind::text = 'pull') = (actor_id is not null and sync_operation_id is not null));
