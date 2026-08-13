CREATE TABLE `issue_history` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_id` text NOT NULL,
	`note` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_history` ON `issue_history` (`organization_id`,`issue_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `issue_photo` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`uploaded_by_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_photo_issue` ON `issue_photo` (`organization_id`,`issue_id`);--> statement-breakpoint
CREATE TABLE `issue_report` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text,
	`room_id` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`reported_by_id` text NOT NULL,
	`assigned_to_id` text,
	`reported_at` integer NOT NULL,
	`acknowledged_at` integer,
	`resolved_at` integer,
	`resolution_note` text,
	`room_blocked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_issue_report_property` ON `issue_report` (`organization_id`,`property_id`,`status`,`severity`);--> statement-breakpoint
CREATE INDEX `idx_issue_report_room` ON `issue_report` (`organization_id`,`room_id`,`status`);--> statement-breakpoint
CREATE TABLE `lost_item` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`management_no` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`found_at` integer NOT NULL,
	`found_by_id` text NOT NULL,
	`found_location` text NOT NULL,
	`status` text DEFAULT 'FOUND' NOT NULL,
	`storage_location` text,
	`police_report_no` text,
	`police_reported_at` integer,
	`owner_contacted_at` integer,
	`returned_at` integer,
	`disposed_at` integer,
	`disposal_reason` text,
	`retention_due_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_lost_item_management_no` ON `lost_item` (`organization_id`,`property_id`,`management_no`);--> statement-breakpoint
CREATE INDEX `idx_lost_item_property_status` ON `lost_item` (`organization_id`,`property_id`,`status`,`found_at`);--> statement-breakpoint
CREATE INDEX `idx_lost_item_retention` ON `lost_item` (`organization_id`,`retention_due_at`,`status`);--> statement-breakpoint
CREATE TABLE `lost_item_history` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`lost_item_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_id` text NOT NULL,
	`note` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lost_item_history` ON `lost_item_history` (`organization_id`,`lost_item_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `lost_item_photo` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`lost_item_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`uploaded_by_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lost_item_photo_item` ON `lost_item_photo` (`organization_id`,`lost_item_id`);--> statement-breakpoint
ALTER TABLE `room` ADD `sale_status` text DEFAULT 'AVAILABLE' NOT NULL;