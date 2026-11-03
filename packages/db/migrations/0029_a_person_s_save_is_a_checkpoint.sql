-- A member's hand edit in the web editor is a checkpoint: `checkpoint_kind` gains `'edit'`
-- (spec 024, data-model.md § 1).
--
-- Hand-written for the reason 0021 gives, and split from 0030 for the reason 0021 explains at
-- length: Postgres refuses to *use* an enum value in the transaction that added it ("unsafe use of
-- new value"), and drizzle-kit applies every pending migration in one transaction. The CHECK that
-- gives the new kind its shape therefore cannot live in this file, and lives in 0030 instead.
--
-- ## Why a fifth kind rather than a flag
--
-- A save has a parent, a sha, a change summary and an author, exactly as a turn, a revert and a
-- pull do. Making it a kind means it lists, diffs, mirrors and reverts through the paths the other
-- four already use, and nothing downstream special-cases it (spec 024 § Clarifications).
--
-- No backfill. Every existing row is a `baseline`, `turn`, `revert` or `pull`, so 0030's CHECK is
-- satisfied by all of them the moment it is added.

ALTER TYPE "public"."checkpoint_kind" ADD VALUE 'edit';
