-- The check's claim marker (spec 028 research R7): the `now` of the check in flight, cleared by its
-- settle. `next_check_at` alone cannot tell a claim lease from a due time, so a check-now could cut
-- a lease short and let a second check claim the row mid-flight. `forge_app` holds UPDATE on the
-- whole table (0036); `forge_bypass`'s column grant does not need it.

ALTER TABLE "domains" ADD COLUMN "claimed_at" timestamp with time zone;
