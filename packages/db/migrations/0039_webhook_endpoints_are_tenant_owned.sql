-- Row-level security, privileges and CHECKs for the four outbound webhook tables 0038 created
-- (spec 029, data-model.md §§ 1-4).
--
-- Hand-written for the reason 0003, 0009, 0014, 0016, 0018, 0021, 0034 and 0036 give: a policy and
-- a grant belong with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policy (constitution V, research R3)
--
-- `webhook_endpoints`, `webhook_endpoint_projects`, `webhook_sends` and `webhook_send_attempts`
-- are tenant-owned, unlike spec 026's inbound `webhook_deliveries` (a platform table, 0032): an
-- endpoint is created by a member of one organisation and everything under it belongs to that
-- organisation. Each carries `org_id`, a unique `(org_id, id)` and composite FKs, so a row can
-- never point across tenants. Constitution V ("tenant isolation is enforced by the database")
-- gives each the §09 shape: ENABLE + FORCE (the migrator owns the tables and is not exempt), and
-- both USING and WITH CHECK on `app.org_id`. `rls.spec.ts` derives the tables into its gate from
-- the column.
--
-- ## Why forge_app gets DELETE (R12)
--
-- Endpoints are configuration, not containers (ADR 012, 017): they are hard-deleted, their scope,
-- sends and attempts cascade, and retention deletes sends and attempts at 30 days without
-- partitions (R12, as ADR 051 extends it). So forge_app gets the full SELECT, INSERT, UPDATE and DELETE on all four.
--
-- ## Why forge_bypass reads six columns of one table (data-model.md § 4)
--
-- The redelivery sweep finds due sends across every organisation before there is a tenant to set
-- (`webhook_sends_due_idx`), and the in-flight guard counts claimed rows. Every step after the
-- probe runs in the tenant transaction as forge_app. So forge_bypass gets a column-level SELECT on
-- exactly what the probe reads. It does not cover `body`: the payload is tenant data, and a role
-- that reads across tenants never needs it. It gets nothing at all on the other three tables:
-- `webhook_endpoints` references signing secrets, and nothing cross-tenant reads it. As everywhere
-- (0003), forge_bypass gets no INSERT, UPDATE or DELETE.
--
-- ## Why the CHECKs are here and compare `state::text`
--
-- The gotcha 0021, 0034 and 0036 record: drizzle-kit applies every pending migration in one
-- transaction, and Postgres refuses to *use* an enum value added in that transaction; comparing
-- `state::text` never looks the label up in `pg_enum`. The schema declares the same CHECKs, so the
-- snapshot records them and drizzle-kit will not diff them again.
--
--   * `previous_secret_id` and `previous_secret_expires_at` are both null or both set: a rotation
--     overlap always has an end.
--   * `paused_at` is set exactly when `state = 'paused'`.
--   * `next_attempt_at` is set exactly when `state = 'pending'`: a pending send is always due at
--     some time, and nothing else is ever picked up by the sweep.

ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "webhook_endpoint_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_projects" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoint_projects"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "webhook_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_sends" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_sends"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "webhook_send_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_send_attempts" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_send_attempts"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_endpoints" TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_endpoint_projects" TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_sends" TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_send_attempts" TO "forge_app";--> statement-breakpoint
GRANT SELECT ("id", "org_id", "state", "next_attempt_at", "claimed_until", "created_at")
  ON TABLE "webhook_sends" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_previous_secret_check"
  CHECK ((previous_secret_id is null) = (previous_secret_expires_at is null));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_paused_check"
  CHECK ((state::text = 'paused') = (paused_at is not null));--> statement-breakpoint
ALTER TABLE "webhook_sends" ADD CONSTRAINT "webhook_sends_next_attempt_check"
  CHECK ((state::text = 'pending') = (next_attempt_at is not null));
