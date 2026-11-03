-- 0023 made `sync_operations.link_id` nullable and turned the composite FK to `repo_links` into
-- `ON DELETE SET NULL` so an operation outlives its link (spec 018, data-model.md). It kept a
-- bug: a plain SET NULL on a composite key nulls *every* referencing column, `org_id` included,
-- and `org_id` is NOT NULL — so deleting a link raised 23502 and the code had to null `link_id`
-- by hand before the delete (`RepoLinkRepository.delete`, the test harness).
--
-- Hand-written because drizzle-kit has no vocabulary for a column list on the action. Postgres 15
-- added it: `ON DELETE SET NULL (link_id)` nulls only the named column and leaves the tenant on
-- the row, which is what a tenant-owned table needs. The compose stack runs 16. The drizzle schema
-- stays `onDelete: 'set null'` — the snapshot cannot say more, and `db:generate` sees no diff.
--
-- `rls.spec.ts` seeds a link and an operation and deletes the link to prove it.
ALTER TABLE "sync_operations" DROP CONSTRAINT "sync_operations_org_id_link_id_fk";--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_org_id_link_id_fk" FOREIGN KEY ("org_id","link_id") REFERENCES "public"."repo_links"("org_id","id") ON DELETE SET NULL ("link_id") ON UPDATE no action;
