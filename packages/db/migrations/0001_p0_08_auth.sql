CREATE TABLE `password_history` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_password_history_user` ON `password_history` (`organization_id`,`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `user` ADD `password_updated_at` integer;