-- The shape of an `edit` checkpoint: it names the member who saved and belongs to no run
-- (spec 024, data-model.md § 1).
--
-- Hand-written for the reason 0021 and 0028 give: drizzle-kit cannot diff a CHECK, so every one of
-- the five on `checkpoints` is written by hand with its rationale.
--
-- ## Why this is a separate file from 0029
--
-- 0029 adds `'edit'` to `checkpoint_kind`, and Postgres refuses to use a new enum value in the
-- transaction that added it. drizzle-kit applies every *pending* migration in one transaction, so
-- on an empty database 0029 and this file share one — which is also why the comparison is on
-- `kind::text` and not on the enum literal. Casting to text never looks the label up in `pg_enum`,
-- so the CHECK is safe on an empty database and on a migrated one, and means the same thing on
-- both. `checkpoints_pull_check` (0021) is the precedent for exactly this pair of problems.
--
-- ## Why this CHECK
--
-- It is the fifth of the shape CHECKs, one per kind, each saying "this kind, and only this kind,
-- carries these". A hand edit is nobody's turn, so `run_id` is null; FR-008 requires it to name
-- the member who saved, so `actor_id` is set. The biconditional is what keeps the claim honest in
-- both directions: no other kind may carry that combination by accident.
--
-- No backfill: every existing row is a `baseline`, `turn`, `revert` or `pull`, so the left side is
-- false; and each either has a `run_id` (a `turn`) or is not an `edit`, so the equality holds.

ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_edit_shape"
  CHECK ((kind::text = 'edit') = (actor_id is not null and run_id is null));
