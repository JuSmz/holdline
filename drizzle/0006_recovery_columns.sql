ALTER TABLE "payment_operations" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_operations_unapplied_idx" ON "payment_operations" USING btree ("state","applied_at");