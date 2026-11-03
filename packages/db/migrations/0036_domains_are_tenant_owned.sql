-- Row-level security, privileges and CHECKs for `domains`, which 0035 created (spec 028,
-- data-model.md).
--
-- Hand-written for the reason 0003, 0009, 0014, 0016, 0018, 0021 and 0034 give: a policy and a
-- grant belong with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policy (constitution V)
--
-- `domains` is tenant-owned: it carries `org_id`, a unique `(org_id, id)` and a composite FK to
-- `projects`. Constitution V ("tenant isolation is enforced by the database") gives it the §09
-- shape every tenant table has: ENABLE + FORCE (the migrator owns the table and is not exempt),
-- and both USING and WITH CHECK on `app.org_id`, so a row can be neither read nor written outside
-- the transaction's tenant. `rls.spec.ts` derives the table into its gate from the column.
--
-- The one thing that spans tenants is `domains_hostname_live_key` (0035): a hostname is unique
-- among live rows across every organisation (FR-031, R9), as `project_sites_site_label_key` is. A
-- unique index is not a read path, and the API maps its violation to one uniform reason, so the
-- answer never depends on who holds the hostname.
--
-- ## Why forge_app gets no DELETE (R9)
--
-- Rows are never deleted. Every end goes through `removing`, and deregistration settles the row
-- as `failed` or `removed` by UPDATE; the hostname is held until the edge confirms. A row goes
-- with its project or organisation by the FKs' cascade, which needs no grant. So forge_app gets
-- SELECT, INSERT and UPDATE, and a stray DELETE is refused by privilege before RLS is consulted.
--
-- ## Why forge_bypass reads six columns and not the table (R7, R11)
--
-- Two probes run before there is a tenant to set: the check sweep finds due rows across every
-- organisation (`domains_due_idx`, R7), and the route broker resolves a hostname to its
-- organisation and project (`domains_serving_idx`, R11) — the `project_sites` precedent of 0034.
-- Every step after either probe runs in the tenant transaction as forge_app. So forge_bypass gets
-- a column-level SELECT on exactly what the two probes read. It does not cover `ownership_token`:
-- the token is the proof a member controls the zone, and a role that reads across tenants never
-- needs it. As everywhere (0003), forge_bypass gets no INSERT, UPDATE or DELETE.
--
-- ## Why the CHECKs are here and compare `state::text`
--
-- The gotcha 0021 and 0034 record: drizzle-kit applies every pending migration in one
-- transaction, and Postgres refuses to *use* an enum value added in that transaction; comparing
-- `state::text` never looks the label up in `pg_enum`. The schema declares the same CHECKs, so the
-- snapshot records them and drizzle-kit will not diff them again.
--
--   * `hostname` is the normalised ASCII form (R8): at most 253 characters and lower-case.
--   * `ownership_token` is 20 random bytes as lower-case base32: 32 of `[a-z2-7]`.
--   * `failed` ⇒ a reason; `pending`, `active`, `drifted` and `removed` ⇒ none. `removing` may
--     carry either, and that decides whether it settles `failed` or `removed` (R9).
--   * `active` or `drifted` ⇒ ownership verified, certificate active, activated and registered
--     at the edge. FR-009 is written into the schema: nothing serves before all four are proven.
--   * `drifted` ⇔ `drifted_at`: the 30-day release clock is never unset while drifted.
--   * `removing` ⇒ `removal_requested_at`.
--   * `failed` or `removed` ⇒ no `edge_id`: nothing ends while still registered (R10).
--   * `failure_count` is 0–3: it stops at the third consecutive failed check (R6).

ALTER TABLE "domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "domains" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "domains"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "domains" TO "forge_app";--> statement-breakpoint
GRANT SELECT ("id", "org_id", "project_id", "hostname", "state", "next_check_at")
  ON TABLE "domains" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "domains" ADD CONSTRAINT "domains_hostname_format_check"
  CHECK (char_length(hostname) <= 253 and hostname = lower(hostname));--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_ownership_token_format_check"
  CHECK (ownership_token ~ '^[a-z2-7]{32}$');--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_failure_reason_check"
  CHECK ((state::text <> 'failed' or failure_reason is not null)
     and (state::text not in ('pending', 'active', 'drifted', 'removed') or failure_reason is null));--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_serving_proven_check"
  CHECK (state::text not in ('active', 'drifted')
      or (ownership_verified_at is not null and certificate_active_at is not null
          and activated_at is not null and edge_id is not null));--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_drifted_check"
  CHECK ((state::text = 'drifted') = (drifted_at is not null));--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_removing_check"
  CHECK (state::text <> 'removing' or removal_requested_at is not null);--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_ended_deregistered_check"
  CHECK (state::text not in ('failed', 'removed') or edge_id is null);--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_failure_count_check"
  CHECK (failure_count between 0 and 3);
