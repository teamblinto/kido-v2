-- Privileges for the two tables 0047 created (spec 032, data-model.md).
--
-- Hand-written for the reason 0003, 0009 and 0016 give: a grant belongs with the schema that
-- creates the table, and drizzle-kit does not diff grants.
--
-- ## Why linked_accounts has no row-level security (ADR 015)
--
-- A linked subscription is owned by a person, not an organisation: it is a root, the same class
-- as `users`, `oauth_identities` and `mfa_recovery_codes`. It has no `org_id` and no policy, and
-- `rls.spec.ts`'s derived gate (tenant-owned iff it has `org_id`) keeps it out of the tenant gate.
-- forge_app gets the four verbs, as the other roots in 0003: a relink is an UPDATE, an unlink a
-- DELETE. forge_bypass reads only, as everywhere.
--
-- ## Why byos_providers is a platform table, with no DELETE (research R12)
--
-- Whether a provider's subscriptions may be linked is the platform's decision, not a tenant's:
-- one row per provider that has ever been signed off, read by every request that asks whether a
-- provider is offered. So there is no `org_id` and no policy, and `rls.spec.ts` names it in
-- `PLATFORM_TABLES`. forge_app may SELECT, INSERT and UPDATE (sign-off, withdrawal,
-- re-instatement) but not DELETE: a provider's history is kept.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "linked_accounts" TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "byos_providers" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "linked_accounts" TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "byos_providers" TO "forge_bypass";
