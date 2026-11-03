-- Local agents (spec 040: a person's own computer paired through the companion) are retired; BAIOS
-- runs agents only on a person's own subscription, in their cloud agent home (spec 041).
-- Data-only and idempotent: every paired computer's token is revoked (revocation is a timestamp, so
-- each past run still names the device it ran on); no row, run, or event is deleted. Cloud devices
-- (agent homes) are untouched.
UPDATE "local_agent_devices" SET "revoked_at" = now() WHERE "kind" = 'local' AND "revoked_at" IS NULL;
