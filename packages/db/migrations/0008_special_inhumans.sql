CREATE TABLE "outbox" (
	"aggregate" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"origin_org_id" uuid,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "outbox_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trace_id" text,
	"type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_seq_idx" ON "outbox" USING btree ("seq") WHERE "outbox"."published_at" is null;