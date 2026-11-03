-- Row-level security and privileges for `project_context`, which 0027 created (spec 021,
-- data-model.md § project_context).
--
-- Hand-written for the reason 0003, 0009, 0014, 0016, 0018, 0021 and 0026 give: a policy and a
-- grant belong with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policy
--
-- The table is tenant-owned — it carries `org_id` and its primary key `(org_id, project_id)` is
-- also the composite FK to `projects` — so it gets the §09 shape every tenant table has: ENABLE +
-- FORCE (the migrator owns the table and is not exempt), and both USING and WITH CHECK on
-- `app.org_id` so a map can be neither read nor written outside the transaction's tenant.
-- `rls.spec.ts` derives the table into its gate from the column and asserts exactly this.
--
-- ## Why forge_app gets all four verbs
--
-- The map is upserted on every run that finds the tree changed (research R2), read on every turn,
-- and dropped with its project; nothing here is history in FR-003's sense. Every write is the
-- executor's, under the run's fence-holding dispatch. forge_bypass reads for exports and, as
-- everywhere (0003), gets no UPDATE and no DELETE.

ALTER TABLE "project_context" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_context" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_context"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "project_context" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "project_context" TO "forge_bypass";
