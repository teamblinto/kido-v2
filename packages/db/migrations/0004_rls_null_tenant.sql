-- Make "no tenant context" mean NULL rather than the empty string (§09).
--
-- 0002 wrote the predicate exactly as the architecture document illustrates it:
--
--   org_id = current_setting('app.org_id', true)::uuid
--
-- which is correct on a connection that has never carried tenant context, because
-- current_setting(name, true) returns NULL for a customised option that was never set, and
-- `org_id = NULL` is NULL, so the statement sees zero rows. That is the §09 property.
--
-- It is not correct on a connection that has carried tenant context before. Setting a customised
-- option CREATES the placeholder on that backend, and a transaction-scoped set only reverts the
-- VALUE at commit -- to the empty string, not to non-existence. Measured against this schema:
--
--   before any transaction   current_setting('app.org_id', true) IS NULL  -> zero rows
--   inside the transaction   '1111...'                                    -> that tenant's rows
--   after COMMIT or ROLLBACK ''                                           -> ERROR 22P02
--                                                                            invalid input syntax
--                                                                            for type uuid: ""
--
-- Under PgBouncer in transaction mode -- and under any application pool, which is why this is
-- reproducible locally with no PgBouncer at all -- every connection is a reused connection after
-- the first request. So the required behaviour "a query issued outside a tenant transaction
-- returns zero rows, not everything" held only for the first query on each backend, and every one
-- after it raised a driver error instead.
--
-- It failed closed, so no cross-tenant row was ever readable. But an error is not zero rows: the
-- §09 test T06 is required to ship would have failed, and in production a forgotten tenant
-- transaction would surface as a 500 carrying a type-cast message rather than as an empty result.
--
-- NULLIF(..., '') collapses both spellings of "no tenant" onto NULL before the cast is attempted.
-- The predicate is then NULL in exactly the cases it should be, for every table, on every backend,
-- for the whole life of the connection. ALTER POLICY rather than DROP and CREATE so the policy is
-- never absent, not even for the width of this transaction.

ALTER POLICY "tenant_isolation" ON "audit_log"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "invitations"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "memberships"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "org_data_keys"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "project_grants"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "projects"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "secrets"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "workspaces"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
