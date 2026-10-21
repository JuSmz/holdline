ALTER TABLE "bookings" DROP CONSTRAINT "bookings_call_id_calls_id_fk";
--> statement-breakpoint
ALTER TABLE "calls" DROP CONSTRAINT "calls_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;