CREATE TABLE `baseline_exclusion_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`business_date` text NOT NULL,
	`room_type_id` text NOT NULL,
	`guest_count` integer NOT NULL,
	`task_type` text NOT NULL,
	`item_code` text NOT NULL,
	`reason` text NOT NULL,
	`qty` real NOT NULL,
	`computed_to` text NOT NULL,
	`excluded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_baseline_exclusion` ON `baseline_exclusion_log` (`organization_id`,`property_id`,`computed_to`);--> statement-breakpoint
CREATE INDEX `idx_baseline_exclusion_obs` ON `baseline_exclusion_log` (`organization_id`,`observation_id`);--> statement-breakpoint
CREATE TABLE `consumption_baseline` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`guest_count` integer NOT NULL,
	`task_type` text NOT NULL,
	`item_code` text NOT NULL,
	`sample_size` integer NOT NULL,
	`median_qty` real NOT NULL,
	`p10_qty` real NOT NULL,
	`p90_qty` real NOT NULL,
	`max_qty` real NOT NULL,
	`std_dev` real NOT NULL,
	`is_reliable` integer DEFAULT false NOT NULL,
	`computed_from` text NOT NULL,
	`computed_to` text NOT NULL,
	`manual_override` real,
	`override_reason` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_baseline` ON `consumption_baseline` (`organization_id`,`property_id`,`room_type_id`,`guest_count`,`task_type`,`item_code`);--> statement-breakpoint
CREATE INDEX `idx_baseline_property` ON `consumption_baseline` (`organization_id`,`property_id`,`room_type_id`);--> statement-breakpoint
CREATE TABLE `linen_record` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`item_code` text NOT NULL,
	`collected_qty` integer DEFAULT 0 NOT NULL,
	`supplied_qty` integer DEFAULT 0 NOT NULL,
	`damaged_qty` integer DEFAULT 0 NOT NULL,
	`stained_qty` integer DEFAULT 0 NOT NULL,
	`note` text,
	`recorded_by_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_linen` ON `linen_record` (`organization_id`,`task_id`,`item_code`);--> statement-breakpoint
CREATE INDEX `idx_linen_date` ON `linen_record` (`organization_id`,`property_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `observation_config` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`require_beds` integer DEFAULT true NOT NULL,
	`require_trash` integer DEFAULT true NOT NULL,
	`require_towels` integer DEFAULT true NOT NULL,
	`require_amenities` integer DEFAULT false NOT NULL,
	`require_linen` integer DEFAULT false NOT NULL,
	`enabled_item_codes` text DEFAULT '[]' NOT NULL,
	`skip_warn_threshold` integer DEFAULT 20 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_observation_config_property` ON `observation_config` (`organization_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `observation_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	`changed_by_id` text NOT NULL,
	`changed_at` integer NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obs_rev` ON `observation_revision` (`organization_id`,`observation_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_obs_rev_property` ON `observation_revision` (`organization_id`,`property_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `room_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text NOT NULL,
	`room_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`business_date` text NOT NULL,
	`beds_used` integer DEFAULT 0 NOT NULL,
	`trash_level` text DEFAULT 'NONE' NOT NULL,
	`bath_towel_used` integer DEFAULT 0 NOT NULL,
	`face_towel_used` integer DEFAULT 0 NOT NULL,
	`hand_towel_used` integer DEFAULT 0 NOT NULL,
	`bath_mat_used` integer DEFAULT 0 NOT NULL,
	`slippers_used` integer DEFAULT 0 NOT NULL,
	`cups_used` integer DEFAULT 0 NOT NULL,
	`extra_futon_used` integer DEFAULT 0 NOT NULL,
	`amenities_used` text DEFAULT '{}' NOT NULL,
	`note` text,
	`input_duration_ms` integer,
	`used_defaults` integer DEFAULT false NOT NULL,
	`recorded_by_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`client_ts` integer,
	`device_info` text,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obs_task` ON `room_observation` (`organization_id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_obs_idempotency` ON `room_observation` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_obs_room_date` ON `room_observation` (`organization_id`,`room_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_obs_baseline` ON `room_observation` (`organization_id`,`property_id`,`room_type_id`,`business_date`);--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `observation_skipped` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `observation_recorded_at` integer;