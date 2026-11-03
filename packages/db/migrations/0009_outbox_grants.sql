-- Table privileges for the two platform tables 0008 created (§09, §10, spec 005 FR-003a/b).
--
-- Hand-written for the reason 0003 gives: a grant belongs with the schema that creates the table,
-- and drizzle-kit does not diff grants. Until this file, forge_app can do nothing at all to
-- `outbox` and `processed_events` -- which is the right default for a table nobody has decided
-- about, and why `src/schema/rls.spec.ts` went red the moment 0008 landed.
--
-- ## Why these two tables sit outside row-level security
--
-- They are infrastructure, not tenant data. The relay must read every tenant's rows to publish
-- them, so a tenant policy here would only ever be bypassed, and a policy that is always bypassed
-- is a hole with extra steps. Account-scope events (a signup, a password reset) belong to no
-- organisation and must be representable, which rules out a `not null` org column and makes a
-- nullable `org_id` the pattern `audit.ts` already rejected. So neither table has a column named
-- `org_id` (the outbox carries `origin_org_id` as provenance for the envelope), neither has a
-- policy, and `rls.spec.ts` names them as platform exceptions rather than deriving them into the
-- tenant gate.
--
-- ## Why forge_app gets UPDATE on outbox, and nothing gets DELETE
--
-- The relay runs on the application pool as forge_app (FR-003b), not as forge_bypass: it needs one
-- write -- `published_at`, set once -- and a role that can see every tenant must not be one
-- statement away from changing anything. That one write is why `outbox` is the only append-only
-- table in the schema with an UPDATE grant. No role but the owner may DELETE: a published row is
-- retained until roadmap 014 decides a retention policy, and a decision is a migration, not a
-- privilege somebody already holds.
--
-- ## Why processed_events is insert-only, like audit_log
--
-- A row here means "this consumer has handled this event". The consumer base inserts it in the
-- handler's own transaction and treats a conflict as already-done; if the row could be updated or
-- deleted, a repository method or an injected statement could make an event be handled twice, and
-- exactly-once would be a convention again. As with audit_log, a missing privilege is refused by
-- the database with 42501 before RLS is even consulted.
--
-- ## Why forge_bypass stays UPDATE-free
--
-- 0003's comment called the relay "the future outbox relay" and put it on forge_bypass. That was
-- wrong and is corrected there: the relay needs an UPDATE, and the invariant that forge_bypass
-- holds no UPDATE and no DELETE anywhere is worth more than the role's name in an old comment.
-- forge_bypass gains SELECT on both tables for exports and rollups, and nothing else.

GRANT SELECT, INSERT, UPDATE ON TABLE "outbox" TO "forge_app";--> statement-breakpoint

-- Append-only. No UPDATE. No DELETE.
GRANT SELECT, INSERT ON TABLE "processed_events" TO "forge_app";--> statement-breakpoint

GRANT SELECT ON TABLE "outbox"           TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "processed_events" TO "forge_bypass";
