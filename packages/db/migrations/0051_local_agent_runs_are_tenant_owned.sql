-- Row-level security and privileges for the two tables 0050 created (spec 040, § 3 decisions 3,
-- 4 and 9).
--
-- Hand-written for the reason 0003, 0009, 0016, 0028 and 0048 give: a policy and a grant belong
-- with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why local_agent_devices has no row-level security (ADR 015)
--
-- A paired companion is owned by a person, not an organisation: it is a root, the same class as
-- `users` and `linked_accounts`, and the companion's own requests carry a device token and no
-- tenant at all. No `org_id` and no policy, and `rls.spec.ts`'s derived gate (tenant-owned iff it
-- has `org_id`) keeps it out of the tenant gate. forge_app gets the four verbs, as the other roots:
-- a heartbeat and a revocation are UPDATEs, and a person's deletion cascades.
--
-- ## Why local_agent_runs gets the policy
--
-- It is tenant-owned — it carries `org_id`, and its primary key `(org_id, run_id)` is also the
-- composite FK to `agent_runs` (the id-less shape 0028 introduced for `project_context`) — so it
-- gets the §09 shape every tenant table has: ENABLE + FORCE, and both USING and WITH CHECK on
-- `app.org_id`. forge_app gets the four verbs: the session id is written in place by the executor
-- and the row goes with its run. forge_bypass reads only, as everywhere (0003).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "local_agent_devices" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "local_agent_devices" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "local_agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "local_agent_runs" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "local_agent_runs"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "local_agent_runs" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "local_agent_runs" TO "forge_bypass";
