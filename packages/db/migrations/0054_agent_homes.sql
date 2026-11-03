CREATE TABLE "agent_homes" (
	"daytona_id" text,
	"device_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_error" text,
	"last_used_at" timestamp with time zone,
	"provider" text NOT NULL,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_agent_devices" ADD COLUMN "kind" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_homes" ADD CONSTRAINT "agent_homes_device_id_local_agent_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."local_agent_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_homes" ADD CONSTRAINT "agent_homes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_homes_user_id_provider_key" ON "agent_homes" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_homes_device_id_key" ON "agent_homes" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "agent_homes_state_idx" ON "agent_homes" USING btree ("state");--> statement-breakpoint
-- Spec 041. agent_homes is a root (ADR 015), like local_agent_devices: owned by a person, no
-- org_id, no row-level security. forge_app gets the four verbs (a home is created, its state
-- moves, and it is deleted on disconnect); forge_bypass reads only, as everywhere (0003).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_homes" TO "forge_app";--> statement-breakpoint
GRANT SELECT ON TABLE "agent_homes" TO "forge_bypass";
