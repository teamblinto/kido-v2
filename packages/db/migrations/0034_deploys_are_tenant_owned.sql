-- Row-level security, privileges and CHECKs for `deployments` and `project_sites`, which 0033
-- created (spec 027, data-model.md).
--
-- Hand-written for the reason 0003, 0009, 0014, 0016, 0018 and 0021 give: a policy and a grant
-- belong with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policies
--
-- Both are tenant-owned — each carries `org_id` and composite FKs to `projects`, and to
-- `checkpoints` or each other — so they get the §09 shape every tenant table has: ENABLE + FORCE
-- (the migrator owns the table and is not exempt), and both USING and WITH CHECK on `app.org_id`
-- so a row can be neither read nor written outside the transaction's tenant. `rls.spec.ts` derives
-- both into its gate from the column and asserts exactly this.
--
-- ## Why forge_app gets no DELETE
--
-- A deployment moves `queued → building → uploading → succeeded | failed | cancelled` by UPDATE
-- and is then the record of a release: rollback and roll-forward point back at it, so nothing on
-- the request, worker or sweep path ever deletes one. A `project_sites` row is the release
-- pointer; offline and archive set `offline_at`, they do not remove it. Both go with their project
-- by the composite FKs' cascade, which needs no grant. So forge_app gets SELECT, INSERT and UPDATE,
-- and a stray DELETE is refused by privilege before RLS is consulted.
--
-- ## Why forge_bypass reads `project_sites` and not `deployments`
--
-- The gateway's route broker resolves a site label to its organisation before there is a tenant
-- to set — the preview precedent, `route-broker.service.ts` step 1. That probe reads
-- `project_sites` alone; nothing outside a tenant transaction reads `deployments`. As everywhere
-- (0003), forge_bypass gets no INSERT, UPDATE or DELETE.
--
-- ## Why the CHECKs are here and compare `state::text`
--
-- The same gotcha 0021 records: drizzle-kit applies every pending migration in one transaction,
-- and Postgres refuses to *use* an enum value added in that transaction. 0033 creates the enums
-- rather than adding values to them, which Postgres allows, but comparing `state::text` never
-- looks the label up in `pg_enum`, so a later `ALTER TYPE … ADD VALUE` in the same run cannot make
-- these fail either. The schema declares the same CHECKs, so the snapshot records them and
-- drizzle-kit will not diff them again.
--
--   * `succeeded` ⇔ an artifact: a live pointer can only ever name a built manifest.
--   * `failed` ⇔ a reason: the UI never shows a failure it cannot explain.
--   * terminal ⇔ `finished_at`.
--   * `uploading` ⇒ `upload_started_at`: the retry boundary (R8) is never unset past it.
--   * `log_tail` ≤ 64 KiB: the worker truncates; the database refuses what the worker forgot to.
--   * `site_label` is one DNS label (R10): lower-case letters, digits and inner hyphens, 1–63
--     characters. It is the site's host name, so the database refuses anything a host cannot be.

ALTER TABLE "deployments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployments" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deployments"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "project_sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_sites" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_sites"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "deployments"   TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "project_sites" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "project_sites" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "deployments" ADD CONSTRAINT "deployments_failed_reason_check"
  CHECK ((state::text = 'failed') = (failure_reason is not null));--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_finished_check"
  CHECK ((state::text in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null));--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_log_tail_size_check"
  CHECK (char_length(log_tail) <= 65536);--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_succeeded_artifact_check"
  CHECK ((state::text = 'succeeded') = (artifact_sha is not null));--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_uploading_check"
  CHECK (state::text <> 'uploading' or upload_started_at is not null);--> statement-breakpoint

ALTER TABLE "project_sites" ADD CONSTRAINT "project_sites_site_label_format_check"
  CHECK (site_label ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
