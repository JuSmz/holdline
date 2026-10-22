CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"call_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"name" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_notifications" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "caller" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "chat_turn_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "summary_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "voice_reserved_minutes" integer;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_calls_call_tool_uq" ON "agent_tool_calls" USING btree ("call_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_one_pending_per_call_uq" ON "bookings" USING btree ("call_id") WHERE status = 'pending_payment' and call_id is not null;