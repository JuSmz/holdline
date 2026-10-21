CREATE TYPE "public"."authorization_role" AS ENUM('active', 'replaced', 'orphan');--> statement-breakpoint
CREATE TYPE "public"."booking_actor" AS ENUM('agent', 'owner', 'customer', 'system', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending_payment', 'authorized', 'completed', 'no_show', 'cancelled', 'captured', 'voided', 'expired', 'paid_out');--> statement-breakpoint
CREATE TYPE "public"."capture_kind" AS ENUM('full', 'no_show_fee', 'late_cancel_fee');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('extra_work', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notify_via" AS ENUM('server', 'browser', 'chat');--> statement-breakpoint
CREATE TYPE "public"."operation_state" AS ENUM('in_flight', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'failed', 'outbox_only');--> statement-breakpoint
CREATE TYPE "public"."pay_token_purpose" AS ENUM('email_link', 'device_link');--> statement-breakpoint
CREATE TYPE "public"."payment_issue" AS ENUM('authorization_pending', 'reauth_failed', 'hold_lost', 'capture_failed', 'capture_pending', 'payout_failed');--> statement-breakpoint
CREATE TYPE "public"."payout_source" AS ENUM('capture', 'invoice');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'unclaimed', 'cancelling', 'succeeded', 'failed', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."service_category" AS ENUM('plumbing', 'electrical');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('bounce', 'complaint');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('emergency', 'soon', 'flexible');--> statement-breakpoint
CREATE TABLE "addon_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"unit" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"paypal_authorization_id" text NOT NULL,
	"parent_authorization_id" uuid,
	"paypal_order_id" text,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"honor_until" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"reauthorize_at" timestamp with time zone,
	"role" "authorization_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorizations_paypal_authorization_id_unique" UNIQUE("paypal_authorization_id")
);
--> statement-breakpoint
CREATE TABLE "booking_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_claims_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
CREATE TABLE "booking_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_status" "booking_status",
	"to_status" "booking_status",
	"flag" text,
	"actor" "booking_actor" NOT NULL,
	"reason" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"status" "booking_status" DEFAULT 'pending_payment' NOT NULL,
	"payment_issue" "payment_issue",
	"version" integer DEFAULT 0 NOT NULL,
	"service_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"customer_id" uuid,
	"call_id" uuid,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"service_name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"no_show_fee_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"problem_summary" text,
	"urgency" "urgency" DEFAULT 'flexible' NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"authorizing_until" timestamp with time zone,
	"active_authorization_id" uuid,
	"authorized_at" timestamp with time zone,
	"cancel_reason" text,
	"sample" boolean DEFAULT false NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "call_notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"status" text NOT NULL,
	"channel" text NOT NULL,
	"via" "notify_via",
	"ok" boolean,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"paypal_capture_id" text NOT NULL,
	"kind" "capture_kind" NOT NULL,
	"amount_cents" integer NOT NULL,
	"final_capture" boolean NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captures_paypal_capture_id_unique" UNIQUE("paypal_capture_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text,
	"email_hmac" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirm_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email_hmac" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_email_hmac_unique" UNIQUE("email_hmac")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"paypal_invoice_id" text,
	"invoice_number" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"items" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"payer_view_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_paypal_invoice_id_unique" UNIQUE("paypal_invoice_id"),
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "outbox_emails" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"idempotency_key" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"booking_id" uuid,
	"to_hmac" text NOT NULL,
	"to" text,
	"template" text NOT NULL,
	"subject" text NOT NULL,
	"html" text,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"resend_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_emails_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "pay_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" "pay_token_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "payment_operations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"booking_id" uuid,
	"paypal_request_id" text,
	"state" "operation_state" NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_operations_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"source" "payout_source" NOT NULL,
	"source_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"sender_batch_id" text NOT NULL,
	"sender_item_id" text NOT NULL,
	"paypal_batch_id" text,
	"paypal_item_id" text,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"transaction_status" text,
	"sample" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_sender_batch_id_unique" UNIQUE("sender_batch_id")
);
--> statement-breakpoint
CREATE TABLE "paypal_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"paypal_order_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_orders_paypal_order_id_unique" UNIQUE("paypal_order_id")
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"window" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" "service_category" NOT NULL,
	"description" text NOT NULL,
	"price_cents" integer NOT NULL,
	"duration_min" integer NOT NULL,
	"no_show_fee_cents" integer NOT NULL,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technicians" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"skills" "service_category"[] NOT NULL,
	"payout_email" text,
	"payout_share_bps" integer NOT NULL,
	"working_hours" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "chat_session_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "caller_hash" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "gemini_contents" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "sandbox_buyer_index" integer;--> statement-breakpoint
ALTER TABLE "addon_items" ADD CONSTRAINT "addon_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_parent_authorization_id_authorizations_id_fk" FOREIGN KEY ("parent_authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_claims" ADD CONSTRAINT "booking_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_claims" ADD CONSTRAINT "booking_claims_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_active_authorization_id_authorizations_id_fk" FOREIGN KEY ("active_authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notifications" ADD CONSTRAINT "call_notifications_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_emails" ADD CONSTRAINT "outbox_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_emails" ADD CONSTRAINT "outbox_emails_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_tokens" ADD CONSTRAINT "pay_tokens_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addon_items_workspace_key_uq" ON "addon_items" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "authorizations_booking_idx" ON "authorizations" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_events_booking_idx" ON "booking_events" USING btree ("booking_id","at");--> statement-breakpoint
CREATE INDEX "bookings_workspace_slot_idx" ON "bookings" USING btree ("workspace_id","slot_start");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_live_slot_uq" ON "bookings" USING btree ("technician_id","slot_start") WHERE status in ('pending_payment', 'authorized') and not sample;--> statement-breakpoint
CREATE UNIQUE INDEX "call_notifications_uq" ON "call_notifications" USING btree ("booking_id","status","channel");--> statement-breakpoint
CREATE INDEX "captures_booking_idx" ON "captures" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_booking_seq_uq" ON "invoices" USING btree ("booking_id","seq");--> statement-breakpoint
CREATE INDEX "outbox_emails_status_idx" ON "outbox_emails" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payment_operations_inflight_idx" ON "payment_operations" USING btree ("state","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_natural_key_uq" ON "payouts" USING btree ("source","source_id","technician_id","attempt_no");--> statement-breakpoint
CREATE INDEX "payouts_booking_idx" ON "payouts" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_orders_booking_attempt_uq" ON "paypal_orders" USING btree ("booking_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_counters_uq" ON "rate_counters" USING btree ("scope","key","window");--> statement-breakpoint
CREATE UNIQUE INDEX "services_workspace_key_uq" ON "services" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "technicians_workspace_key_uq" ON "technicians" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "calls_workspace_idx" ON "calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_chat_session_id_unique" UNIQUE("chat_session_id");