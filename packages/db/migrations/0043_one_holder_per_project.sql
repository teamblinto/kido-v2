-- One holder per project (spec 031, research R1/R1a, ADR 060).
--
-- Hand-written: the data fix below must precede the index, and drizzle-kit emits neither a
-- data fix nor the order.
--
-- ## Why this migration rewrites run rows
--
-- A project's holder is its non-terminal run with `started_at` set. Until 031 nothing stopped two
-- runs from holding one project at once, so existing data may already contain two or more. The
-- unique index below is a backstop the claim gate should never trip, and it cannot be created
-- over rows that violate it. So every started, non-terminal run that is not the oldest on its
-- project is moved to `cancelled` with `ended_at = now()` first — `cancelled`, not `failed`,
-- because `failure_class` is an enum mirrored in `RUN_FAILURE_CLASSES` and one data fix does not
-- earn a contract change. Decision recorded 2026-09-23 (plan.md § Ask-first items).

update agent_runs r
set status = 'cancelled', ended_at = now(), lease_until = null, updated_at = now()
where r.started_at is not null
  and r.status not in ('succeeded', 'failed', 'cancelled')
  and exists (
    select 1 from agent_runs o
    where o.org_id = r.org_id
      and o.project_id = r.project_id
      and o.started_at is not null
      and o.status not in ('succeeded', 'failed', 'cancelled')
      and (o.started_at, o.created_at, o.id) < (r.started_at, r.created_at, r.id)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_holder_per_project" ON "agent_runs" USING btree ("org_id","project_id") WHERE "agent_runs"."started_at" is not null and "agent_runs"."status" not in ('succeeded', 'failed', 'cancelled');
--> statement-breakpoint
CREATE INDEX "agent_runs_line_idx" ON "agent_runs" USING btree ("org_id","project_id","created_at","id") WHERE "agent_runs"."started_at" is null and "agent_runs"."status" not in ('succeeded', 'failed', 'cancelled');
