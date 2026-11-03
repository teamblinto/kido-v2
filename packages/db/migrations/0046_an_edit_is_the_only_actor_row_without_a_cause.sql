-- Corrects `checkpoints_edit_shape` (0030, spec 024 data-model § 1), which rejects every `revert`
-- and every `pull` row.
--
-- Hand-written for the reason 0021, 0028 and 0030 give: drizzle-kit cannot diff a CHECK well
-- enough to be trusted with one, so each CHECK on `checkpoints` carries its rationale by hand.
--
-- ## What 0030 got wrong
--
-- 0030's right side was `actor_id is not null and run_id is null`. Its no-backfill argument said a
-- `revert` or `pull` satisfies the equality because "the kind is not `edit`" — but that only makes
-- the left side false. A `revert` (0016's CHECK: an actor and a `reverts_id`) and a `pull` (0021's:
-- an actor and a `sync_operation_id`) also carry an actor and no run, so the right side is true and
-- the biconditional fails. Every revert and every pull insert has been refused since 0030.
--
-- ## Why this CHECK
--
-- The intent is unchanged: an `edit` names the member who saved (FR-008) and belongs to no run,
-- and no other kind may carry that shape by accident. What distinguishes an edit from a revert or
-- a pull is that it has neither of their causes, so the right side now also requires `reverts_id`
-- and `sync_operation_id` null. The biconditional still holds in both directions: a `turn` has a
-- run, a `baseline` has no actor, a `revert` has a `reverts_id`, a `pull` a `sync_operation_id`.
--
-- `kind::text` for 0030's reason: it never names the enum label, so it is safe in any transaction.
--
-- Not an edit of 0030: that migration is applied wherever this schema runs, and drizzle-kit
-- tracks applied files by hash. Dropping and re-adding in one file is atomic under the migrator's
-- transaction; every existing row satisfies the new CHECK (an `edit` row has no `reverts_id` or
-- `sync_operation_id` — no code path sets them on one), so no backfill.

ALTER TABLE "checkpoints" DROP CONSTRAINT "checkpoints_edit_shape";--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_edit_shape"
  CHECK ((kind::text = 'edit') = (actor_id is not null and run_id is null and reverts_id is null and sync_operation_id is null));
