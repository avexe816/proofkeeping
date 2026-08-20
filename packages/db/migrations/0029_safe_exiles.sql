CREATE TABLE `residency_record` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`staff_profile_id` text NOT NULL,
	`status_type` text NOT NULL,
	`status_label` text,
	`expires_on` text,
	`renewal_applied_on` text,
	`work_permit_required` integer DEFAULT false NOT NULL,
	`weekly_hour_limit` integer,
	`note` text,
	`updated_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_residency_staff` ON `residency_record` (`organization_id`,`staff_profile_id`);--> statement-breakpoint
CREATE INDEX `idx_residency_expires` ON `residency_record` (`organization_id`,`expires_on`);--> statement-breakpoint
CREATE TABLE `shift_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`business_date` text NOT NULL,
	`shift_type` text NOT NULL,
	`property_id` text,
	`start_at` text,
	`end_at` text,
	`break_minutes` integer DEFAULT 60 NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_shift_plan` ON `shift_plan` (`organization_id`,`membership_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_shift_plan_date` ON `shift_plan` (`organization_id`,`business_date`);--> statement-breakpoint
ALTER TABLE `staff_pay_profile` ADD `hired_on` text;--> statement-breakpoint
ALTER TABLE `staff_pay_profile` ADD `resigned_on` text;--> statement-breakpoint
ALTER TABLE `staff_pay_profile` ADD `work_status` text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `staff_pay_profile` ADD `languages` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `staff_pay_profile` ADD `skills` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `staff_pay_profile` ADD `note` text;--> statement-breakpoint
CREATE INDEX `idx_staff_pay_profile_status` ON `staff_pay_profile` (`organization_id`,`work_status`);