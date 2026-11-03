CREATE TYPE "public"."webhook_delivery_state" AS ENUM('received', 'processed', 'ignored', 'failed');--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'empty-repo';--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'repo-too-large';--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'branch-not-found';--> statement-breakpoint
ALTER TYPE "public"."sync_failure_reason" ADD VALUE 'import-checkout-failed';--> statement-breakpoint
ALTER TYPE "public"."sync_kind" ADD VALUE 'import';--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"body" jsonb,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"failure" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint,
	"provider" "connector_provider" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"state" "webhook_delivery_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_provider_delivery_id_key" UNIQUE("provider","delivery_id")
);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_failed_idx" ON "webhook_deliveries" USING btree ("state","received_at") WHERE "webhook_deliveries"."state" = 'failed';