-- Row-level security and privileges for `provider_keys`, which 0025 created (spec 020,
-- data-model.md § provider_keys).
--
-- Hand-written for the reason 0003, 0009, 0014, 0016, 0018 and 0021 give: a policy and a grant
-- belong with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policy
--
-- The table is tenant-owned — it carries `org_id` and a composite FK to `secrets` — so it gets the
-- §09 shape every tenant table has: ENABLE + FORCE (the migrator owns the table and is not
-- exempt), and both USING and WITH CHECK on `app.org_id` so a row can be neither read nor written
-- outside the transaction's tenant. `rls.spec.ts` derives the table into its gate from the column
-- and asserts exactly this.
--
-- ## Why forge_app gets all four verbs
--
-- A key is stored, replaced (delete-then-insert in one transaction), re-verified (`health`,
-- `last_verified_at`) and removed. Nothing here is history in FR-003's sense — the audit trail is.
-- forge_bypass reads for exports and, as everywhere (0003), gets no UPDATE and no DELETE.

ALTER TABLE "provider_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_keys" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "provider_keys"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "provider_keys" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "provider_keys" TO "forge_bypass";
