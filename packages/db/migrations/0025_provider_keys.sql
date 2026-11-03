CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai');--> statement-breakpoint
ALTER TYPE "public"."run_failure_class" ADD VALUE 'credential';--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"added_by" uuid,
	"health" "connector_health" NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_four" text NOT NULL,
	"last_verified_at" timestamp with time zone,
	"org_id" uuid NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"secret_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_keys_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "provider_keys_org_id_provider_key" UNIQUE("org_id","provider")
);
--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_org_id_secret_id_fk" FOREIGN KEY ("org_id","secret_id") REFERENCES "public"."secrets"("org_id","id") ON DELETE cascade ON UPDATE no action;