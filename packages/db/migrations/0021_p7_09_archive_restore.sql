CREATE TABLE `archive_restore` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`requested_by_id` text NOT NULL,
	`property_id` text,
	`from_business_date` text NOT NULL,
	`to_business_date` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`table_count` integer DEFAULT 0 NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`error_code` text,
	`requested_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_archive_restore` ON `archive_restore` (`organization_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `idx_archive_restore_status` ON `archive_restore` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `archive_restore_row` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`restore_id` text NOT NULL,
	`table_name` text NOT NULL,
	`business_date` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_archive_restore_row` ON `archive_restore_row` (`organization_id`,`restore_id`,`table_name`);