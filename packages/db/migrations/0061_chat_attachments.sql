CREATE TYPE "public"."attachment_kind" AS ENUM('image', 'pdf', 'document', 'text', 'archive');--> statement-breakpoint
CREATE TABLE "attachments" (
	"extracted_text" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "attachment_kind" NOT NULL,
	"mime_type" text NOT NULL,
	"name" text NOT NULL,
	"object_key" text NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "run_message_attachments" (
	"attachment_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_message_attachments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "run_message_attachments_message_attachment_key" UNIQUE("org_id","message_id","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_project_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_message_attachments" ADD CONSTRAINT "run_message_attachments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_message_attachments" ADD CONSTRAINT "run_message_attachments_org_id_message_id_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "public"."run_messages"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_message_attachments" ADD CONSTRAINT "run_message_attachments_org_id_attachment_id_fk" FOREIGN KEY ("org_id","attachment_id") REFERENCES "public"."attachments"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_org_id_project_id_created_at_idx" ON "attachments" USING btree ("org_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "run_message_attachments_org_id_attachment_id_idx" ON "run_message_attachments" USING btree ("org_id","attachment_id");