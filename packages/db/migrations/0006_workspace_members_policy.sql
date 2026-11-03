-- Row-level security and table privileges for workspace_members (§09, T27).
--
-- Hand-written for the reason 0002 gives: drizzle-kit diffs tables, columns, keys and indexes, and
-- a policy is none of those. It will never emit this file and will never notice if it is missing --
-- which is why `src/schema/rls.spec.ts` derives the table list from the database rather than from a
-- list somebody has to remember to update. That test is what turns "we forgot" into a red build,
-- and it is the reason this file exists in the same commit as 0005 rather than after it.
--
-- ENABLE and FORCE, both. FORCE is not optional: forge_migrator owns the table, and ENABLE alone
-- exempts the owner -- and anything running as it, including the seed -- from the isolation the
-- policy exists to provide.
--
-- The predicate is 0004's, not 0002's, written correctly the first time for this table. NULLIF
-- collapses "never set" and "set and reverted to the empty string" onto NULL, so a query issued
-- outside a tenant transaction returns zero rows on every backend for the whole life of the
-- connection, rather than raising 22P02 on the second request to reuse it.
--
-- Both clauses carry the same predicate. USING filters what a statement reads; WITH CHECK
-- constrains what it writes. USING alone would let a tenant insert a workspace membership stamped
-- with somebody else's org_id -- the write succeeds, and RLS then hides the evidence from the
-- tenant it was filed under. This table grants access, so that row would be a standing
-- cross-tenant grant nobody can see.

ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_members" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workspace_members"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Privileges, per 0003. forge_app writes it on the request path; forge_bypass reads it for the
-- cross-tenant work §09 permits and gets no UPDATE and no DELETE, because a role that can see every
-- tenant's rows must not be one statement away from changing them.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workspace_members" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "workspace_members" TO "forge_bypass";
