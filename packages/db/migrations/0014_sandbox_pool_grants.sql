-- Invariants on `sandboxes` and privileges for the two pool tables 0013 created (spec 014,
-- data-model.md § Invariants, § sandbox_pool, § sandbox_pool_settings).
--
-- Hand-written for the reason 0003 and 0009 give: a grant belongs with the schema that creates the
-- table and drizzle-kit does not diff grants. Until this file forge_app can do nothing to
-- `sandbox_pool` or `sandbox_pool_settings`, which is why `src/schema/rls.spec.ts` went red the
-- moment 0013 landed.
--
-- ## Why the three CHECKs
--
-- A `transition` is an in-flight provider op and `transition_since` is the reconciler's clock for
-- deciding it has gone stale; one without the other is a row the reconciler can never settle, so
-- the database refuses it rather than trusting every repository method to set both.
-- `hibernated_at` is the resume path's evidence that there is a snapshot to wake, so a
-- `hibernated` row without it is refused for the same reason. `archived` is a state the enum
-- declares (spec 010, §06's vocabulary) that this feature never writes: FR-013 says a hibernated
-- sandbox stays hibernated until spec 016 decides what an archive is and where its snapshot
-- lives. The CHECK makes that a fact rather than a convention; 016 drops it.
--
-- ## Why the pool tables sit outside row-level security
--
-- A pool entry belongs to no tenant. It is created by the refill on behalf of nobody, and the
-- claim transaction deletes it here and inserts it into `sandboxes` — the first moment it has an
-- `org_id`. So neither table has a column named `org_id`, neither has a policy, and `rls.spec.ts`
-- names them as platform exceptions rather than deriving them into the tenant gate, like `outbox`.
--
-- ## Why forge_app gets all four verbs, and forge_bypass reads only
--
-- The refill INSERTs, the op consumer UPDATEs a row to `ready` or `releasing`, and the claim *is*
-- a `DELETE … WHERE state = 'ready' RETURNING` — every verb is on the request or worker path as
-- forge_app. `sandbox_pool_settings` is written only by the `sandbox:pool` command, which also
-- runs as forge_app. forge_bypass gains SELECT for exports and rollups and, as everywhere (0003),
-- no UPDATE and no DELETE.

ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_transition_since_check"
  CHECK (transition IS NULL OR transition_since IS NOT NULL);--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_hibernated_at_check"
  CHECK (state <> 'hibernated' OR hibernated_at IS NOT NULL);--> statement-breakpoint
-- FR-013: no archive in this feature. Spec 016 drops this constraint when it defines one.
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_not_archived_check"
  CHECK (state <> 'archived');--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sandbox_pool"          TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sandbox_pool_settings" TO "forge_app";--> statement-breakpoint

GRANT SELECT ON TABLE "sandbox_pool"          TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "sandbox_pool_settings" TO "forge_bypass";
