CREATE TABLE "mcp_clients" (
	"client_name" text NOT NULL,
	"client_uri" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"access_expires_at" timestamp with time zone NOT NULL,
	"access_token_hash" text NOT NULL,
	"client_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_used_at" timestamp with time zone,
	"org_id" uuid NOT NULL,
	"previous_refresh_hash" text,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"scopes" text[] NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_grants_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_client_id_mcp_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_grants_access_token_hash_key" ON "mcp_grants" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_grants_refresh_token_hash_key" ON "mcp_grants" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "mcp_grants_previous_refresh_hash_idx" ON "mcp_grants" USING btree ("previous_refresh_hash");--> statement-breakpoint
CREATE INDEX "mcp_grants_org_id_user_id_idx" ON "mcp_grants" USING btree ("org_id","user_id");