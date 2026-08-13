CREATE TABLE `evidence_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text,
	`business_date` text NOT NULL,
	`evidence_type` text NOT NULL,
	`schema_version` text NOT NULL,
	`payload` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`previous_hash` text,
	`chain_hash` text NOT NULL,
	`corrects_snapshot_id` text,
	`correction_reason` text,
	`created_at` integer NOT NULL,
	`created_by_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_task_created` ON `evidence_snapshot` (`organization_id`,`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_evidence_property_date_type` ON `evidence_snapshot` (`organization_id`,`property_id`,`business_date`,`evidence_type`);--> statement-breakpoint
CREATE TABLE `inspection` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text NOT NULL,
	`round` integer NOT NULL,
	`inspector_id` text NOT NULL,
	`result` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`duration_seconds` integer,
	`self_approved` integer DEFAULT false NOT NULL,
	`override_reason` text,
	`general_note` text,
	`client_ts` integer,
	`idempotency_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inspection_task_round` ON `inspection` (`organization_id`,`task_id`,`round`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inspection_idempotency` ON `inspection` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_inspection_property_completed` ON `inspection` (`organization_id`,`property_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_inspection_inspector_completed` ON `inspection` (`organization_id`,`inspector_id`,`completed_at`);--> statement-breakpoint
CREATE TABLE `inspection_item_result` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`inspection_id` text NOT NULL,
	`checklist_item_id` text NOT NULL,
	`status` text NOT NULL,
	`defect_code` text,
	`note` text,
	`rework_required` integer DEFAULT false NOT NULL,
	`rework_due_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inspection_item_result` ON `inspection_item_result` (`organization_id`,`inspection_id`,`checklist_item_id`);--> statement-breakpoint
CREATE INDEX `idx_inspection_item_result_status` ON `inspection_item_result` (`organization_id`,`inspection_id`,`status`);--> statement-breakpoint
CREATE TABLE `inspection_photo` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`item_result_id` text NOT NULL,
	`inspection_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`file_size` integer NOT NULL,
	`captured_at` integer,
	`uploaded_by_id` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`client_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inspection_photo_client_id` ON `inspection_photo` (`organization_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inspection_photo_item` ON `inspection_photo` (`organization_id`,`item_result_id`);--> statement-breakpoint
CREATE INDEX `idx_inspection_photo_inspection` ON `inspection_photo` (`organization_id`,`inspection_id`);--> statement-breakpoint
CREATE TABLE `property_inspection_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`mode` text DEFAULT 'ALL' NOT NULL,
	`sample_rate` integer DEFAULT 100 NOT NULL,
	`min_daily_sample` integer DEFAULT 3 NOT NULL,
	`always_inspect_checkin` integer DEFAULT true NOT NULL,
	`always_inspect_rework` integer DEFAULT true NOT NULL,
	`self_inspection_allowed` integer DEFAULT false NOT NULL,
	`auto_assign_inspector` integer DEFAULT true NOT NULL,
	`inspection_sla_minutes` integer DEFAULT 20 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inspection_policy_property` ON `property_inspection_policy` (`organization_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `rework_cycle` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`task_id` text NOT NULL,
	`inspection_id` text NOT NULL,
	`round` integer NOT NULL,
	`assigned_to_id` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`reason_summary` text NOT NULL,
	`due_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`waived_by_id` text,
	`waived_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_rework_cycle_task_round` ON `rework_cycle` (`organization_id`,`task_id`,`round`);--> statement-breakpoint
CREATE INDEX `idx_rework_cycle_assignee_status` ON `rework_cycle` (`organization_id`,`assigned_to_id`,`status`);--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `inspection_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `inspection_skipped` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `inspection_skip_reason` text;--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `inspector_id` text;--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `inspected_at` integer;--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `inspection_result` text;--> statement-breakpoint
ALTER TABLE `cleaning_task` ADD `current_inspection_round` integer DEFAULT 0 NOT NULL;