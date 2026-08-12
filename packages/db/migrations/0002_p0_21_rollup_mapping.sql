CREATE TABLE `daily_property_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`business_date` text NOT NULL,
	`total_tasks` integer DEFAULT 0 NOT NULL,
	`completed_tasks` integer DEFAULT 0 NOT NULL,
	`rework_tasks` integer DEFAULT 0 NOT NULL,
	`total_minutes` integer DEFAULT 0 NOT NULL,
	`open_issues` integer DEFAULT 0 NOT NULL,
	`findings_high` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_rollup` ON `daily_property_rollup` (`organization_id`,`property_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_rollup_org` ON `daily_property_rollup` (`organization_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `external_mapping` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`internal_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_label` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_map_int` ON `external_mapping` (`organization_id`,`integration_id`,`entity_type`,`internal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_map_ext` ON `external_mapping` (`organization_id`,`integration_id`,`entity_type`,`external_id`);