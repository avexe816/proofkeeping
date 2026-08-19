CREATE TABLE `pay_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text,
	`property_id` text,
	`task_type` text,
	`unit_type` text NOT NULL,
	`unit_price` integer NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pay_rule_membership` ON `pay_rule` (`organization_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `idx_pay_rule_property` ON `pay_rule` (`organization_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `payout_line` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`payout_period_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`line_type` text NOT NULL,
	`property_id` text,
	`description` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_type` text,
	`unit_price` integer NOT NULL,
	`amount` integer NOT NULL,
	`task_ids` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`warning` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_payout_line_period` ON `payout_line` (`organization_id`,`payout_period_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `payout_period` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`aggregated_at` integer,
	`confirmed_at` integer,
	`document_no` text,
	`total_amount` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payout_period` ON `payout_period` (`organization_id`,`membership_id`,`period_from`,`period_to`);--> statement-breakpoint
CREATE INDEX `idx_payout_period_status` ON `payout_period` (`organization_id`,`status`,`period_to`);--> statement-breakpoint
CREATE TABLE `staff_pay_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`employment_type` text NOT NULL,
	`invoice_registration_no` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_pay_profile` ON `staff_pay_profile` (`organization_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `idx_staff_pay_profile` ON `staff_pay_profile` (`organization_id`,`is_active`);