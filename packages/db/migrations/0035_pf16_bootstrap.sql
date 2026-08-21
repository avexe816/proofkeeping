CREATE TABLE `platform_bootstrap_token` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_bootstrap_token_token_hash_unique` ON `platform_bootstrap_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_platform_bootstrap_expires` ON `platform_bootstrap_token` (`expires_at`);