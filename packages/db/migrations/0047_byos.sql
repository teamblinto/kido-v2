CREATE TYPE "public"."byos_provider_status" AS ENUM('in_force', 'withdrawn');--> statement-breakpoint
CREATE TABLE "byos_providers" (
	"provider" "llm_provider" PRIMARY KEY NOT NULL,
	"record" text NOT NULL,
	"signed_off_at" timestamp with time zone NOT NULL,
	"status" "byos_provider_status" NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linked_accounts" (
	"access_expires_at" timestamp with time zone NOT NULL,
	"account_label" text NOT NULL,
	"grant_sealed" "bytea" NOT NULL,
	"health" "connector_health" NOT NULL,
	"health_changes" integer DEFAULT 0 NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"limited_until" timestamp with time zone,
	"linked_at" timestamp with time zone NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_accounts_user_id_provider_key" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "personal_accounts_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linked_accounts_provider_last_checked_at_idx" ON "linked_accounts" USING btree ("provider","last_checked_at");