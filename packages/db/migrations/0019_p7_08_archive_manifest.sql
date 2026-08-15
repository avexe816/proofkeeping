CREATE TABLE `archive_manifest` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`year` integer NOT NULL,
	`table_name` text NOT NULL,
	`object_key` text NOT NULL,
	`row_count` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`cutoff_business_date` text NOT NULL,
	`archived_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_archive_manifest` ON `archive_manifest` (`organization_id`,`year`,`table_name`);--> statement-breakpoint
CREATE INDEX `idx_archive_manifest` ON `archive_manifest` (`organization_id`,`archived_at`);