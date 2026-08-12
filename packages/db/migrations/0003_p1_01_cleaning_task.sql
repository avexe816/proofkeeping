CREATE TABLE `checklist_item` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`template_id` text NOT NULL,
	`section` text NOT NULL,
	`labels` text NOT NULL,
	`is_required` integer DEFAULT true NOT NULL,
	`photo_required` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_checklist_item_template` ON `checklist_item` (`organization_id`,`template_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `checklist_template` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text,
	`room_type_id` text,
	`task_type` text NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_checklist_template_scope` ON `checklist_template` (`organization_id`,`property_id`,`task_type`,`is_active`);--> statement-breakpoint
CREATE TABLE `cleaning_task` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`task_type` text NOT NULL,
	`status` text DEFAULT 'CREATED' NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`assignee_id` text,
	`standard_minutes` integer NOT NULL,
	`actual_minutes` integer,
	`pause_count` integer DEFAULT 0 NOT NULL,
	`rework_count` integer DEFAULT 0 NOT NULL,
	`source_type` text DEFAULT 'AUTO' NOT NULL,
	`note` text,
	`blocked_reason` text,
	`short_id` text NOT NULL,
	`sequence_in_day` integer,
	`assigned_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cleaning_task_room_date_type` ON `cleaning_task` (`organization_id`,`room_id`,`business_date`,`task_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cleaning_task_short_id` ON `cleaning_task` (`organization_id`,`short_id`);--> statement-breakpoint
CREATE INDEX `idx_cleaning_task_property_date_status` ON `cleaning_task` (`organization_id`,`property_id`,`business_date`,`status`);--> statement-breakpoint
CREATE INDEX `idx_cleaning_task_assignee_date_status` ON `cleaning_task` (`organization_id`,`assignee_id`,`business_date`,`status`);--> statement-breakpoint
CREATE INDEX `idx_cleaning_task_org_date` ON `cleaning_task` (`organization_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `daily_room_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`has_checkout` integer DEFAULT false NOT NULL,
	`has_checkin` integer DEFAULT false NOT NULL,
	`is_stayover` integer DEFAULT false NOT NULL,
	`guest_count` integer DEFAULT 0 NOT NULL,
	`decline_clean` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'MANUAL' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_daily_room_plan_room_date` ON `daily_room_plan` (`organization_id`,`room_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_daily_room_plan_property_date` ON `daily_room_plan` (`organization_id`,`property_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `standard_time` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`task_type` text NOT NULL,
	`minutes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_standard_time_property_room_type_task` ON `standard_time` (`organization_id`,`property_id`,`room_type_id`,`task_type`);--> statement-breakpoint
CREATE TABLE `task_checklist_result` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text NOT NULL,
	`item_id` text NOT NULL,
	`template_version` integer NOT NULL,
	`is_required` integer NOT NULL,
	`photo_required` integer NOT NULL,
	`value` text,
	`reason_code` text,
	`checked_at` integer,
	`checked_by_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_checklist_result_task_item` ON `task_checklist_result` (`organization_id`,`task_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_task_checklist_result_task` ON `task_checklist_result` (`organization_id`,`task_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `task_photo` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text NOT NULL,
	`checklist_item_id` text,
	`kind` text DEFAULT 'AFTER' NOT NULL,
	`storage_key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`file_size` integer NOT NULL,
	`captured_at` integer,
	`uploaded_at` integer NOT NULL,
	`uploaded_by_id` text NOT NULL,
	`client_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_photo_client_id` ON `task_photo` (`organization_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `idx_task_photo_task_kind` ON `task_photo` (`organization_id`,`task_id`,`kind`);--> statement-breakpoint
CREATE TABLE `task_time_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text NOT NULL,
	`event` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`actor_id` text NOT NULL,
	`reason_code` text,
	`client_ts` integer,
	`idempotency_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_time_log_idempotency` ON `task_time_log` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_task_time_log_task` ON `task_time_log` (`organization_id`,`task_id`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `property` ADD `inspection_required` integer DEFAULT false NOT NULL;