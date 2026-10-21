CREATE TABLE "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_api_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"op" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"http_status" integer,
	"request_id" text,
	"resource_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resource_status" text,
	"debug_id" text,
	"issue" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"paypal_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"summary" text,
	"raw" jsonb NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"verified_via" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "webhook_events_paypal_event_id_unique" UNIQUE("paypal_event_id")
);
--> statement-breakpoint
CREATE INDEX "paypal_api_log_at_idx" ON "paypal_api_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");