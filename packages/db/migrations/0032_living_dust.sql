CREATE TABLE `platform_operation_setting` (
	`id` text PRIMARY KEY NOT NULL,
	`input_duration_floor_seconds` integer DEFAULT 10 NOT NULL,
	`default_rate_threshold_percent` integer DEFAULT 70 NOT NULL,
	`photo_retention_days` integer DEFAULT 90 NOT NULL,
	`rooms_per_staff_limit` integer DEFAULT 16 NOT NULL,
	`maintenance_start_jst` text DEFAULT '03:00' NOT NULL,
	`maintenance_end_jst` text DEFAULT '04:00' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_tenant_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`business_date` text NOT NULL,
	`name` text NOT NULL,
	`plan` text,
	`subscription_status` text,
	`contracted_on` text,
	`trial_ends_on` text,
	`property_count` integer DEFAULT 0 NOT NULL,
	`room_count` integer DEFAULT 0 NOT NULL,
	`billable_room_count` integer DEFAULT 0 NOT NULL,
	`staff_count` integer DEFAULT 0 NOT NULL,
	`completed_tasks` integer DEFAULT 0 NOT NULL,
	`observations_recorded` integer DEFAULT 0 NOT NULL,
	`observations_skipped` integer DEFAULT 0 NOT NULL,
	`observations_used_defaults` integer DEFAULT 0 NOT NULL,
	`input_duration_median_ms` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_snapshot` ON `platform_tenant_snapshot` (`organization_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_platform_snapshot_date` ON `platform_tenant_snapshot` (`business_date`);