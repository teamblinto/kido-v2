-- Table privileges for the two runtime roles (§09).
--
-- infra/postgres/init-roles.sql deliberately stops at CONNECT and USAGE ON SCHEMA: table grants
-- belong with the schema that creates the tables, so that a table added by a migration cannot be
-- reachable before somebody has decided what may be done to it. Ownership stays with
-- forge_migrator, which is why FORCE ROW LEVEL SECURITY in 0002 is what it is.
--
-- audit_log gets SELECT and INSERT and nothing else. Append-only is a privilege here, not a
-- convention: with no UPDATE and no DELETE granted, a repository method, a migration written by
-- somebody in a hurry, or an injected statement cannot rewrite the trail -- it is refused by the
-- database with 42501 before RLS is even consulted. `src/schema/rls.spec.ts` connects as forge_app
-- and proves it.
--
-- forge_bypass holds BYPASSRLS and does the cross-tenant work §09 permits: exports and usage
-- rollups. (Not the outbox relay, as this comment once said: the relay runs as forge_app, because
-- it needs an UPDATE -- see 0009.) It is granted SELECT everywhere and INSERT on audit_log only,
-- because §09 also requires that every statement it issues is itself written to the audit log. It
-- gets no UPDATE and no DELETE anywhere: a role that can see every tenant's rows must not be one
-- statement away from changing them.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "email_verification_tokens" TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "invitations"               TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "memberships"               TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mfa_recovery_codes"        TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "oauth_identities"          TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "org_data_keys"             TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "orgs"                      TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "password_reset_tokens"     TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "project_grants"            TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "projects"                  TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "secrets"                   TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "users"                     TO "forge_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workspaces"                TO "forge_app";--> statement-breakpoint

-- Append-only. No UPDATE. No DELETE. Ever.
GRANT SELECT, INSERT ON TABLE "audit_log" TO "forge_app";--> statement-breakpoint

GRANT SELECT ON TABLE "audit_log"                 TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "email_verification_tokens" TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "invitations"               TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "memberships"               TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "mfa_recovery_codes"        TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "oauth_identities"          TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "org_data_keys"             TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "orgs"                      TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "password_reset_tokens"     TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "project_grants"            TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "projects"                  TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "secrets"                   TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "users"                     TO "forge_bypass";--> statement-breakpoint
GRANT SELECT ON TABLE "workspaces"                TO "forge_bypass";--> statement-breakpoint

-- The audit trail of its own cross-tenant work (§09).
GRANT INSERT ON TABLE "audit_log" TO "forge_bypass";
