CREATE TABLE `audit_finding` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`rule_code` text NOT NULL,
	`rule_version` text NOT NULL,
	`severity` text NOT NULL,
	`confidence` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`evidence` text NOT NULL,
	`matched_signals` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`assigned_to_id` text,
	`resolved_by_id` text,
	`resolved_at` integer,
	`resolution_code` text,
	`resolution_note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_finding` ON `audit_finding` (`organization_id`,`room_id`,`business_date`,`rule_code`);--> statement-breakpoint
CREATE INDEX `idx_finding_status` ON `audit_finding` (`organization_id`,`property_id`,`status`,`severity`);--> statement-breakpoint
CREATE INDEX `idx_finding_date` ON `audit_finding` (`organization_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_finding_run` ON `audit_finding` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `detection_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text,
	`rule_code` text NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feedback` ON `detection_feedback` (`organization_id`,`property_id`,`rule_code`,`created_at`);--> statement-breakpoint
CREATE TABLE `occupancy_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`source` text NOT NULL,
	`is_occupied` integer NOT NULL,
	`guest_count` integer DEFAULT 0 NOT NULL,
	`adult_count` integer DEFAULT 0 NOT NULL,
	`child_count` integer DEFAULT 0 NOT NULL,
	`reservation_ref` text,
	`channel_code` text,
	`check_in_at` integer,
	`check_out_at` integer,
	`is_stayover` integer DEFAULT false NOT NULL,
	`nights_total` integer,
	`night_index` integer,
	`rate_plan_code` text,
	`is_complimentary` integer DEFAULT false NOT NULL,
	`is_house_use` integer DEFAULT false NOT NULL,
	`raw_payload` text,
	`imported_at` integer NOT NULL,
	`imported_by_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_occ` ON `occupancy_snapshot` (`organization_id`,`room_id`,`business_date`,`source`);--> statement-breakpoint
CREATE INDEX `idx_occ_prop_date` ON `occupancy_snapshot` (`organization_id`,`property_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `physical_signal` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`signal_type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`actor_type` text,
	`actor_ref` text,
	`device_id` text,
	`raw_payload` text,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sig_room_date` ON `physical_signal` (`organization_id`,`room_id`,`business_date`,`signal_type`);--> statement-breakpoint
CREATE INDEX `idx_sig_time` ON `physical_signal` (`organization_id`,`property_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `reconciliation_run` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`business_date` text NOT NULL,
	`engine_version` text NOT NULL,
	`ruleset_hash` text NOT NULL,
	`status` text NOT NULL,
	`rooms_evaluated` integer DEFAULT 0 NOT NULL,
	`rules_evaluated` integer DEFAULT 0 NOT NULL,
	`findings_created` integer DEFAULT 0 NOT NULL,
	`findings_suppressed` integer DEFAULT 0 NOT NULL,
	`available_sources` text NOT NULL,
	`skip_reason` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_run` ON `reconciliation_run` (`organization_id`,`property_id`,`business_date`,`engine_version`);--> statement-breakpoint
CREATE INDEX `idx_run_property` ON `reconciliation_run` (`organization_id`,`property_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `room_access_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`room_id` text NOT NULL,
	`business_date` text NOT NULL,
	`purpose` text NOT NULL,
	`entered_at` integer NOT NULL,
	`exited_at` integer,
	`actor_id` text,
	`actor_name` text,
	`note` text,
	`registered_by_id` text NOT NULL,
	`registered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_access` ON `room_access_log` (`organization_id`,`room_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `rule_config` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text,
	`rule_code` text NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`severity_override` text,
	`thresholds` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_rule_cfg` ON `rule_config` (`organization_id`,`property_id`,`rule_code`);