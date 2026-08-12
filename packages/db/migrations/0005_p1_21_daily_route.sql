CREATE TABLE `daily_route` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`business_date` text NOT NULL,
	`sequence` integer NOT NULL,
	`property_id` text NOT NULL,
	`planned_start_at` text,
	`planned_end_at` text,
	`travel_minutes` integer,
	`actual_start_at` integer,
	`actual_end_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_daily_route_member_date_seq` ON `daily_route` (`organization_id`,`membership_id`,`business_date`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_daily_route_date` ON `daily_route` (`organization_id`,`business_date`);