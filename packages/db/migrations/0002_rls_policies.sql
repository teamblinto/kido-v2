-- Row-level security for every tenant-owned table (§09).
--
-- Hand-written, because drizzle-kit cannot express a policy: it diffs tables, columns, keys and
-- indexes, and a policy is none of those. Regenerating the schema will never emit this file, and
-- will never notice if it is missing -- which is why `src/schema/rls.spec.ts` derives the table list
-- from the database rather than from a list anybody has to remember to update.
--
-- Two clauses per table, not one. USING filters rows the statement READS; WITH CHECK constrains
-- rows the statement WRITES. A policy with USING alone lets a tenant INSERT a row stamped with
-- somebody else's org_id -- the write succeeds, and RLS then hides the evidence from the tenant who
-- created it. Both clauses carry the same predicate deliberately: a tenant may see and write its own
-- rows, and nothing else.
--
-- ENABLE and FORCE, not just ENABLE. ENABLE applies the policy to everyone except the table's owner;
-- forge_migrator owns these tables, so without FORCE the migrator -- and anything that ever runs as
-- it, including the seed -- is exempt from the isolation the policy exists to provide. FORCE is also
-- the reason infra/postgres/init-roles.sql provisions three roles rather than two.
--
-- current_setting('app.org_id', true) returns NULL when the GUC has never been set, so the predicate
-- is `org_id = NULL` -- never true. A query issued outside a tenant transaction therefore returns
-- zero rows rather than every row, which §09 names as a required CI test (T06 asserts it).
--
-- forge_bypass is unaffected: it holds BYPASSRLS for the cross-tenant work §09 permits -- exports,
-- rollups, the future outbox relay -- on its own pool, with every statement audited.

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitations"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "org_data_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_data_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org_data_keys"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "project_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_grants"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "projects"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "secrets"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workspaces"
  USING      (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
