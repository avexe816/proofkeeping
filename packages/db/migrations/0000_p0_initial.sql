CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text,
	`actor_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`before` text,
	`after` text,
	`reason` text,
	`ip` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_org_at` ON `audit_log` (`organization_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_org_target` ON `audit_log` (`organization_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_org_action_at` ON `audit_log` (`organization_id`,`action`,`at`);--> statement-breakpoint
CREATE TABLE `building` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_building_property_name` ON `building` (`organization_id`,`property_id`,`name`);--> statement-breakpoint
CREATE TABLE `document_sequence` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`document_type` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_document_sequence` ON `document_sequence` (`organization_id`,`document_type`,`fiscal_year`);--> statement-breakpoint
CREATE INDEX `idx_document_sequence_org` ON `document_sequence` (`organization_id`);--> statement-breakpoint
CREATE TABLE `floor` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`building_id` text,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_floor_property_building_name` ON `floor` (`organization_id`,`property_id`,`building_id`,`name`);--> statement-breakpoint
CREATE TABLE `membership` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text,
	`invited_at` integer,
	`accepted_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_membership_org_user` ON `membership` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_membership_org_role` ON `membership` (`organization_id`,`role`);--> statement-breakpoint
CREATE TABLE `module_entitlement` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text,
	`module_code` text NOT NULL,
	`is_enabled` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'PLAN' NOT NULL,
	`valid_from` integer,
	`valid_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_module_entitlement` ON `module_entitlement` (`organization_id`,`property_id`,`module_code`);--> statement-breakpoint
CREATE INDEX `idx_module_entitlement_lookup` ON `module_entitlement` (`organization_id`,`module_code`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`org_short_id` text NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Tokyo' NOT NULL,
	`locale` text DEFAULT 'ja' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_organization_short_id` ON `organization` (`org_short_id`);--> statement-breakpoint
CREATE TABLE `organization_tax_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`legal_name` text NOT NULL,
	`invoice_registration_number` text,
	`default_tax_rounding_mode` text DEFAULT 'ROUND' NOT NULL,
	`postal_code` text,
	`address` text,
	`tel` text,
	`seal_image_key` text,
	`fiscal_year_start_month` integer DEFAULT 4 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tax_profile_org` ON `organization_tax_profile` (`organization_id`);--> statement-breakpoint
CREATE TABLE `property` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`postal_code` text,
	`address` text,
	`timezone` text DEFAULT 'Asia/Tokyo' NOT NULL,
	`day_cutoff_time` text DEFAULT '05:00' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_property_org_code` ON `property` (`organization_id`,`code`);--> statement-breakpoint
CREATE INDEX `idx_property_org` ON `property` (`organization_id`);--> statement-breakpoint
CREATE TABLE `property_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`property_id` text NOT NULL,
	`assigned_by` text,
	`assigned_at` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_property_assignment` ON `property_assignment` (`organization_id`,`membership_id`,`property_id`);--> statement-breakpoint
CREATE INDEX `idx_property_assignment_property` ON `property_assignment` (`organization_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `room` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`building_id` text,
	`floor_id` text,
	`room_type_id` text,
	`room_number` text NOT NULL,
	`is_sellable` integer DEFAULT true NOT NULL,
	`source_type` text DEFAULT 'MANUAL' NOT NULL,
	`external_room_id` text,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_room_property_number` ON `room` (`organization_id`,`property_id`,`room_number`);--> statement-breakpoint
CREATE INDEX `idx_room_property_sellable` ON `room` (`organization_id`,`property_id`,`is_sellable`);--> statement-breakpoint
CREATE TABLE `room_type` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`bed_count` integer,
	`capacity` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_room_type_property_code` ON `room_type` (`organization_id`,`property_id`,`code`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`billing_cycle` text DEFAULT 'MONTHLY' NOT NULL,
	`trial_ends_at` integer,
	`current_period_start` integer,
	`current_period_end` integer,
	`unit_price_yen` integer DEFAULT 0 NOT NULL,
	`minimum_charge_yen` integer DEFAULT 0 NOT NULL,
	`external_ref` text,
	`canceled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_subscription_org` ON `subscription` (`organization_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text,
	`password_hash` text,
	`staff_number` text,
	`pin_hash` text,
	`pin_must_change` integer DEFAULT true NOT NULL,
	`display_name` text NOT NULL,
	`locale` text DEFAULT 'ja' NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_login_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_org_email` ON `user` (`organization_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_org_staff_number` ON `user` (`organization_id`,`staff_number`);--> statement-breakpoint
CREATE TABLE `org_directory` (
	`org_short_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_org_directory_organization` ON `org_directory` (`organization_id`);