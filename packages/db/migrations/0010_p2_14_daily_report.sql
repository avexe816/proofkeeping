CREATE TABLE `daily_report` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`business_date` text NOT NULL,
	`document_no` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`storage_key` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`pdf_sha256` text NOT NULL,
	`total_tasks` integer DEFAULT 0 NOT NULL,
	`completed_tasks` integer DEFAULT 0 NOT NULL,
	`failed_first_inspection` integer DEFAULT 0 NOT NULL,
	`open_issues` integer DEFAULT 0 NOT NULL,
	`open_lost_items` integer DEFAULT 0 NOT NULL,
	`generated_at` integer NOT NULL,
	`generated_by_id` text,
	`supersedes_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_daily_report_revision` ON `daily_report` (`organization_id`,`property_id`,`business_date`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_daily_report_property_date` ON `daily_report` (`organization_id`,`property_id`,`business_date`);