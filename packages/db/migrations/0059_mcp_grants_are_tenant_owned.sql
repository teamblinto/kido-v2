-- Row-level security and privileges for the two tables 0058 created (spec 046).
--
-- Hand-written for the reason 0003, 0009, 0016, 0028 and 0048 give: a policy and a grant belong
-- with the schema that creates the table and drizzle-kit emits neither.
--
-- ## Why mcp_clients has no row-level security (ADR 015)
--
-- A dynamically registered OAuth client belongs to no person and no organisation: registration is
-- unauthenticated by design (RFC 7591), and the row only names where an authorization code may be
-- sent. A root, like `users`; forge_app gets the four verbs.
--
-- ## Why mcp_grants gets the policy
--
-- A grant is one person's consent for one client to act inside one organisation, so it is
-- tenant-owned and gets the §09 shape every tenant table has. The bearer lookup on the MCP endpoint
-- runs before any tenant is known and reads the row by token hash through forge_bypass, which reads
-- only, as everywhere (0003); every write — issue, rotate, touch, revoke — runs in the grant's own
-- tenant transaction.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mcp_clients" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "mcp_clients" TO "forge_bypass";--> statement-breakpoint

ALTER TABLE "mcp_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_grants" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mcp_grants"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mcp_grants" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "mcp_grants" TO "forge_bypass";
