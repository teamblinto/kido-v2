-- run_events: the first partitioned tenant-owned table (spec 008, §09, ADR 032).
--
-- Hand-written whole, not just its policy. drizzle-kit cannot say `partition by`, cannot put the
-- partition column into a primary key it did not invent, and has no notion of a child partition
-- or a creator function; `src/schema/agent.ts` declares the table for typing only and 0010 had
-- its generated DDL removed. This file is the one place the shape of run_events is decided.
--
-- ## Why partitioned on day one, and by hand
--
-- §09 lists run_events with audit_log and usage_events as the tables that grow without bound and
-- get monthly partitions. ADR 016 deferred audit_log's partitioning because retrofitting one
-- constraint on one table was cheap; run_events is written by every worker at every milestone, so
-- the cheap moment is before the first row. pg_partman is still out of scope: monthly ranges
-- declared by a function the reaper calls once a day cover the same ground with nothing to
-- install, and the DEFAULT partition catches a row whose month nobody declared instead of raising.
--
-- ## Why the key is (org_id, run_id, seq, at) and there is no id
--
-- Postgres requires the partition column inside every unique constraint, so the convention's
-- `unique (org_id, id)` cannot exist here. Identity is `(run_id, seq)` -- the reader pages by seq
-- and nothing references an event row -- so an `id` column would be a uuid nobody uses, and a
-- unique key that has to carry `at` anyway may as well be the primary key that begins with org_id.
-- `src/schema/schema.spec.ts` learns exactly this shape: a partitioned tenant-owned table passes
-- the key gate with a primary key led by org_id and closed by its partition column, and only that.
--
-- ## Isolation and privileges
--
-- ENABLE and FORCE on the parent, both. A policy on the parent governs every row reached through
-- it, and the application reaches rows through the parent only: no partition is granted to
-- forge_app, so a statement naming run_events_2026_09 directly is refused by privilege before RLS
-- is a question. forge_app gets SELECT and INSERT on the parent only: an event is a fact about the
-- past, like an audit row, and a role that cannot UPDATE cannot rewrite one. `updated_at` exists
-- to satisfy the tenant-owned gate and will never change. forge_bypass reads for exports.
--
-- The creator function is SECURITY DEFINER because `CREATE TABLE ... PARTITION OF` needs the
-- parent's owner, and the reaper runs as forge_app. It takes one date and builds one name from
-- it, so there is nothing for a caller to inject.

CREATE TABLE "run_events" (
  "org_id"     uuid        NOT NULL REFERENCES "public"."orgs"("id") ON DELETE cascade,
  "run_id"     uuid        NOT NULL,
  "seq"        integer     NOT NULL,
  "type"       text        NOT NULL,
  "data"       jsonb       NOT NULL,
  "at"         timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "run_events_pkey" PRIMARY KEY ("org_id", "run_id", "seq", "at"),
  CONSTRAINT "run_events_org_id_run_id_fk" FOREIGN KEY ("org_id", "run_id")
    REFERENCES "public"."agent_runs"("org_id", "id") ON DELETE cascade
) PARTITION BY RANGE ("at");--> statement-breakpoint

-- One month, idempotent. `RunReaper` calls it daily for next month; a migration or an operator
-- may call it for any month. Named run_events_YYYY_MM.
CREATE FUNCTION create_run_events_partition(month date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  start_at date := date_trunc('month', month)::date;
  end_at   date := (date_trunc('month', month) + interval '1 month')::date;
  name     text := 'run_events_' || to_char(start_at, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF run_events FOR VALUES FROM (%L) TO (%L)',
    name, start_at, end_at);
END
$$;--> statement-breakpoint

SELECT create_run_events_partition(date_trunc('month', now())::date);--> statement-breakpoint
SELECT create_run_events_partition((date_trunc('month', now()) + interval '1 month')::date);--> statement-breakpoint
CREATE TABLE "run_events_default" PARTITION OF "run_events" DEFAULT;--> statement-breakpoint

ALTER TABLE "run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_events" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "run_events"
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Append-only. No UPDATE. No DELETE. The parent only; see above for why partitions get nothing.
GRANT SELECT, INSERT ON TABLE "run_events" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "run_events" TO "forge_bypass";--> statement-breakpoint
REVOKE ALL ON FUNCTION create_run_events_partition(date) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_run_events_partition(date) TO "forge_app";
