CREATE TABLE `platform_recovery_code` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_platform_recovery_operator` ON `platform_recovery_code` (`operator_id`);--> statement-breakpoint
ALTER TABLE `platform_operator` ADD `two_factor_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `platform_operator` ADD `two_factor_failed_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_operator` ADD `two_factor_locked_until` integer;--> statement-breakpoint
ALTER TABLE `platform_operator` ADD `two_factor_last_step` integer;