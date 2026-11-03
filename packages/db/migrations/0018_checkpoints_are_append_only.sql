-- Row-level security and privileges for `checkpoints`, which 0017 created (spec 016,
-- data-model.md § checkpoints).
--
-- Hand-written for the reason 0003, 0009, 0014 and 0016 give: a policy and a grant belong with
-- the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policy
--
-- A checkpoint is tenant-owned — it carries `org_id` and a composite FK to `projects` — so it gets
-- the §09 shape every tenant table has: ENABLE + FORCE (the migrator owns the table and is not
-- exempt), and both USING and WITH CHECK on `app.org_id` so a row can be neither read nor
-- written outside the transaction's tenant. `rls.spec.ts` derives the table into its gate from
-- the column and asserts exactly this.
--
-- ## Why forge_app may UPDATE one column and DELETE nothing
--
-- FR-003: a checkpoint is a fact about the project's past. A revert is a *new* checkpoint that
-- points back (`reverts_id`), never a rewrite of an old one, and nothing in the product removes
-- history. The one thing that changes after the insert is `mirrored_at`, set once by the mirror
-- consumer when the bundle is in the object store. So the UPDATE grant is column-scoped to it:
-- an `UPDATE … SET label` or a `DELETE` as forge_app is a privilege error (42501) before RLS is
-- even consulted, which `rls.spec.ts` probes as the role itself. The cascade from `projects` runs
-- as the table owner and is unaffected. forge_bypass reads for exports and, as everywhere (0003),
-- gets no UPDATE and no DELETE.

ALTER TABLE "checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "checkpoints" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "checkpoints"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE (mirrored_at) ON TABLE "checkpoints" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "checkpoints" TO "forge_bypass";
