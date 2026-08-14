CREATE TABLE `api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`property_ids` text,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_api_key_hash` ON `api_key` (`organization_id`,`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_key_org` ON `api_key` (`organization_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `integration` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text,
	`kind` text NOT NULL,
	`vendor_code` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'INACTIVE' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`credential_ref` text,
	`sync_mode` text DEFAULT 'PULL' NOT NULL,
	`sync_cron` text,
	`webhook_secret_ref` text,
	`last_sync_at` integer,
	`last_success_at` integer,
	`last_error_at` integer,
	`last_error_message` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_integration` ON `integration` (`organization_id`,`property_id`,`kind`,`vendor_code`);--> statement-breakpoint
CREATE INDEX `idx_integration_kind` ON `integration` (`organization_id`,`kind`,`status`);--> statement-breakpoint
CREATE TABLE `notification_preference` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`event_code` text NOT NULL,
	`channels` text DEFAULT '[]' NOT NULL,
	`quiet_hours_from` text,
	`quiet_hours_to` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notif_pref` ON `notification_preference` (`organization_id`,`membership_id`,`event_code`);--> statement-breakpoint
CREATE TABLE `outbound_webhook` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`url` text NOT NULL,
	`secret_ref` text NOT NULL,
	`events` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_delivery_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_outbound_webhook` ON `outbound_webhook` (`organization_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `push_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`is_standalone` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_push` ON `push_subscription` (`organization_id`,`membership_id`,`endpoint`);--> statement-breakpoint
CREATE TABLE `sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`direction` text NOT NULL,
	`trigger` text NOT NULL,
	`target_date` text,
	`status` text NOT NULL,
	`records_received` integer DEFAULT 0 NOT NULL,
	`records_applied` integer DEFAULT 0 NOT NULL,
	`records_skipped` integer DEFAULT 0 NOT NULL,
	`records_failed` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`raw_sample` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sync` ON `sync_log` (`organization_id`,`integration_id`,`started_at`);