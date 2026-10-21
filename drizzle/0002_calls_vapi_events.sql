CREATE TYPE "public"."call_channel" AS ENUM('web', 'phone', 'chat');--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" "call_channel" NOT NULL,
	"vapi_call_id" text,
	"vapi_call_type" text,
	"lab" boolean DEFAULT false NOT NULL,
	"control_url" text,
	"status" text DEFAULT 'created' NOT NULL,
	"llm_model" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_s" integer,
	"transcript" text,
	"messages" jsonb,
	"metrics" jsonb,
	"cost_cents" integer,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_vapi_call_id_unique" UNIQUE("vapi_call_id")
);
--> statement-breakpoint
CREATE TABLE "vapi_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"endpoint" text NOT NULL,
	"message_type" text NOT NULL,
	"vapi_call_id" text,
	"call_type" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_created_idx" ON "calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "vapi_events_received_idx" ON "vapi_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "vapi_events_call_idx" ON "vapi_events" USING btree ("vapi_call_id");