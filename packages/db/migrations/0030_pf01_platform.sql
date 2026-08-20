CREATE TABLE `platform_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text,
	`action` text NOT NULL,
	`target_organization_id` text,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_platform_audit_created` ON `platform_audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_audit_operator` ON `platform_audit_log` (`operator_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `platform_operator` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`two_factor_secret` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_operator_email_unique` ON `platform_operator` (`email`);--> statement-breakpoint
CREATE INDEX `idx_platform_operator_status` ON `platform_operator` (`status`);