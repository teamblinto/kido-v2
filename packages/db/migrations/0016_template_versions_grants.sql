-- Invariants and privileges for `template_versions`, which 0015 created (spec 015,
-- data-model.md § template_versions).
--
-- Hand-written for the reason 0003, 0009 and 0014 give: a grant belongs with the schema that
-- creates the table and drizzle-kit does not diff grants or CHECKs.
--
-- ## Why the two CHECKs
--
-- `current` is the row the pool creates from, and the refill reads it without looking at
-- `state`; a `current` row that is not `ready` would make the pool create from an image that
-- does not exist. The flip (`TemplateVersions.ready`) sets both in one transaction, and the
-- partial unique index `(template) where current` from 0015 refuses a second concurrent flip —
-- this CHECK refuses the half-flip. A `failed` row is what `template:show` and the next publish
-- explain themselves with, so a failure without a reason is refused rather than trusted to every
-- code path that records one.
--
-- ## Why the table sits outside row-level security
--
-- A version belongs to the catalogue, not a tenant: it is built by an operator's command on
-- behalf of nobody and read by the refill and the claim for every project. So there is no
-- `org_id`, no policy, and `rls.spec.ts` names it as a platform exception like `sandbox_pool`.
--
-- ## Why forge_app gets all four verbs, and forge_bypass reads only
--
-- The publish command (as forge_app, like `sandbox:pool`) INSERTs the reservation and UPDATEs it
-- to `ready`, `failed` or back to `building`; the refill UPDATEs a superseded row to `retired`.
-- DELETE is granted for symmetry with the other pool tables and for a future prune — nothing in
-- 015 issues one. forge_bypass gains SELECT for exports and, as everywhere (0003), no UPDATE and
-- no DELETE.

ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_current_ready_check"
  CHECK (NOT current OR state = 'ready');--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_failure_reason_check"
  CHECK (state <> 'failed' OR failure_reason IS NOT NULL);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "template_versions" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "template_versions" TO "forge_bypass";
