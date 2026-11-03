-- Row-level security and privileges for `project_invitations`, which 0044 created, and the
-- self-read clause on `project_grants` (spec 031, data-model § 2, research R5/R6).
--
-- Hand-written for the reason 0003, 0034 and 0036 give: a policy and a grant belong with the
-- schema that creates the table and drizzle-kit emits neither.
--
-- ## Why the policy on project_invitations (constitution V)
--
-- `project_invitations` is tenant-owned: `org_id`, a unique `(org_id, id)` and a composite FK to
-- `projects`. It gets the §09 shape every tenant table has: ENABLE + FORCE (the migrator owns the
-- table and is not exempt), and both USING and WITH CHECK on `app.org_id`. The accept link carries
-- the organisation beside the token, as the org invitation's does, so acceptance runs inside the
-- policy rather than around it.
--
-- ## Why forge_app gets no DELETE
--
-- The row grants access, so it has no `deleted_at` (ADR 012) and is never deleted either:
-- withdrawn is `revoked_at`, used is `accepted_at`, and the open-invitation partial unique reads
-- those stamps. It goes with its project or organisation by the FKs' cascade, which needs no grant.
--
-- ## Why project_grants gains a USING clause on app.user_id (R6, ADR 023)
--
-- `GET /orgs` is rooted at a person, not a tenant: it has no `app.org_id` to set. 0007 answered
-- that for members by letting `memberships` be read by `app.user_id`. A guest holds no membership
-- — only grants — so the same read on `project_grants` is what lets a guest find the organisations
-- that shared something with them, still as forge_app and still inside a policy rather than through
-- forge_bypass. Exactly 0007's shape: the clause is in USING only; WITH CHECK stays on the org, so a
-- transaction carrying only `app.user_id` can read a person's own grants and write none.

ALTER TABLE "project_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_invitations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_invitations"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "project_invitations" TO forge_app;--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "project_grants"
  USING      (org_id  = nullif(current_setting('app.org_id',  true), '')::uuid
           or user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (org_id  = nullif(current_setting('app.org_id',  true), '')::uuid);
