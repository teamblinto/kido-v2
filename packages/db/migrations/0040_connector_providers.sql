-- The five remaining connector providers (spec 030, data-model § 1).
--
-- Alone in its file, and nothing after it in the same run may *use* the new labels: Postgres
-- refuses a new enum value in the transaction that added it ("unsafe use of new value"), and
-- drizzle-kit applies every pending migration in one transaction — the pitfall 0021's header
-- describes. So on an empty database 0040, 0041 and 0042 share a transaction, and every CHECK in
-- 0042 that names a provider compares `provider::text`, which never looks the label up in
-- `pg_enum`. `ADD VALUE` itself is allowed in a transaction since Postgres 12.
--
-- `connector_provider` is also `webhook_deliveries.provider` (029). The inbound controller's route
-- parameter already restricts deliveries to providers with a verifier, so the wider enum admits no
-- new delivery (research R2).
ALTER TYPE "public"."connector_provider" ADD VALUE 'netlify';--> statement-breakpoint
ALTER TYPE "public"."connector_provider" ADD VALUE 'supabase';--> statement-breakpoint
ALTER TYPE "public"."connector_provider" ADD VALUE 'neon';--> statement-breakpoint
ALTER TYPE "public"."connector_provider" ADD VALUE 'resend';--> statement-breakpoint
ALTER TYPE "public"."connector_provider" ADD VALUE 'cloudflare';