CREATE TABLE `certification_record` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`name` text NOT NULL,
	`expires_on` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_certification_member` ON `certification_record` (`organization_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `idx_certification_expires` ON `certification_record` (`organization_id`,`expires_on`);--> statement-breakpoint
CREATE TABLE `training_program` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`expected_minutes` integer DEFAULT 0 NOT NULL,
	`languages` text DEFAULT '[]' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_training_program` ON `training_program` (`organization_id`,`is_active`,`sort_order`);--> statement-breakpoint
CREATE TABLE `training_record` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`program_id` text NOT NULL,
	`completed_on` text NOT NULL,
	`mentor_membership_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_training_record` ON `training_record` (`organization_id`,`membership_id`,`program_id`);--> statement-breakpoint
CREATE INDEX `idx_training_record_member` ON `training_record` (`organization_id`,`membership_id`);