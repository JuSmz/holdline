CREATE TYPE "public"."workspace_kind" AS ENUM('main', 'demo', 'phone_demo');--> statement-breakpoint
CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"label" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
