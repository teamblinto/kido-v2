CREATE TABLE "local_agent_devices" (
	"companion_version" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_agent_runs" (
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_session_id" text,
	"run_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_agent_runs_pkey" PRIMARY KEY("org_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "local_agent_devices" ADD CONSTRAINT "local_agent_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_device_id_local_agent_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."local_agent_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_agent_runs" ADD CONSTRAINT "local_agent_runs_org_id_run_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."agent_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_agent_devices_token_hash_key" ON "local_agent_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "local_agent_devices_user_id_idx" ON "local_agent_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "local_agent_runs_device_id_idx" ON "local_agent_runs" USING btree ("device_id");