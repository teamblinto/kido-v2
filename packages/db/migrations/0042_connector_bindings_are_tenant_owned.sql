-- Row-level security, privileges and CHECKs for `connector_bindings`, `connector_resources` and
-- `connector_operations`, which 0041 created, and the two CHECKs 0041 generalised `connections`
-- under (spec 030, data-model §§ 2–5).
--
-- Hand-written for the reason 0003, 0021, 0034 and 0036 give: a policy and a grant belong with
-- the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policies (constitution V)
--
-- All three are tenant-owned — `org_id`, a unique `(org_id, id)`, composite FKs to `projects`,
-- `connections`, `domains`, `deployments`, `secrets` and each other — so they get the §09 shape:
-- ENABLE + FORCE (the migrator owns the tables and is not exempt), and both USING and WITH CHECK
-- on `app.org_id`. `rls.spec.ts` derives the three into its gate from the column.
--
-- ## Why forge_app gets all four verbs
--
-- A binding is deleted on unbind once its resources are released; a resource moves through
-- `provisioning → live → releasing → released`; an operation moves `queued → running →
-- succeeded | failed`. None is history in FR-003's sense.
--
-- ## Why forge_bypass reads a few columns and not the tables (R15)
--
-- Organisations are soft-deleted and emit no event, so the health sweep finds a deleted org's live
-- resources, and the ops-timeout job finds stale `running` operations, before there is a tenant to
-- set; every step after the probe runs in the tenant transaction as forge_app. forge_bypass gets a
-- column-level SELECT on exactly what those probes read — never a sealed secret's id, never a
-- binding's `config` — and, as everywhere (0003), no INSERT, UPDATE or DELETE.
--
-- ## Why the CHECKs are here and compare on `::text`
--
-- The gotcha 0021 records: drizzle-kit applies every pending migration in one transaction, and
-- Postgres refuses to *use* an enum value added in that transaction — 0040 adds five
-- `connector_provider` values. Comparing `provider::text` (and, for uniformity, every enum here)
-- never looks the label up in `pg_enum`. The snapshot already records each CHECK (they are
-- declared in `src/schema/connectors.ts`), so drizzle-kit will not diff them again.

ALTER TABLE "connector_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_bindings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_bindings"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "connector_resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_resources" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_resources"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "connector_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_operations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connector_operations"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "connector_bindings" TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "connector_resources" TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "connector_operations" TO "forge_app";--> statement-breakpoint

GRANT SELECT ("id", "org_id", "state")
  ON TABLE "connector_resources" TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ("id", "org_id", "kind", "state", "started_at")
  ON TABLE "connector_operations" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "connections" ADD CONSTRAINT "connections_github_shape"
  CHECK (provider::text <> 'github'
      or (account_id is not null and installation_id is not null and account_type is not null));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_account_ref"
  CHECK (provider::text = 'github' or account_ref is not null);--> statement-breakpoint
ALTER TABLE "connector_bindings" ADD CONSTRAINT "connector_bindings_not_github"
  CHECK (provider::text <> 'github');--> statement-breakpoint
ALTER TABLE "connector_bindings" ADD CONSTRAINT "connector_bindings_state_check"
  CHECK (state::text = 'disconnected' or connection_id is not null);--> statement-breakpoint
ALTER TABLE "connector_resources" ADD CONSTRAINT "connector_resources_single_owner"
  CHECK ((kind::text = 'cloudflare_dns_record' and binding_id is null)
      or (kind::text <> 'cloudflare_dns_record' and domain_id is null));--> statement-breakpoint
ALTER TABLE "connector_operations" ADD CONSTRAINT "connector_operations_reason_when_failed"
  CHECK ((state::text = 'failed') = (reason is not null));--> statement-breakpoint
ALTER TABLE "connector_operations" ADD CONSTRAINT "connector_operations_publish_deployment"
  CHECK (kind::text <> 'netlify_publish' or deployment_id is not null);
