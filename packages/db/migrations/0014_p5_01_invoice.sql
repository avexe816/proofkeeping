CREATE TABLE `billing_period` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`counterparty_id` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`aggregated_at` integer,
	`agreed_at` integer,
	`agreed_by_counterparty` integer DEFAULT false NOT NULL,
	`invoice_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_period` ON `billing_period` (`organization_id`,`counterparty_id`,`period_from`,`period_to`);--> statement-breakpoint
CREATE INDEX `idx_period_status` ON `billing_period` (`organization_id`,`status`,`period_to`);--> statement-breakpoint
CREATE TABLE `counterparty` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`code` text NOT NULL,
	`legal_name` text NOT NULL,
	`display_name` text,
	`invoice_registration_no` text,
	`postal_code` text,
	`address1` text,
	`address2` text,
	`department` text,
	`contact_name` text,
	`billing_email` text NOT NULL,
	`cc_emails` text DEFAULT '[]' NOT NULL,
	`closing_day` integer DEFAULT 31 NOT NULL,
	`payment_term_days` integer DEFAULT 30 NOT NULL,
	`tax_rounding_mode` text DEFAULT 'FLOOR' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cp` ON `counterparty` (`organization_id`,`code`);--> statement-breakpoint
CREATE TABLE `document_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`doc_type` text NOT NULL,
	`document_id` text NOT NULL,
	`channel` text NOT NULL,
	`to_email` text NOT NULL,
	`cc_emails` text DEFAULT '[]' NOT NULL,
	`subject` text NOT NULL,
	`body_preview` text NOT NULL,
	`provider_message_id` text,
	`status` text NOT NULL,
	`error_message` text,
	`sent_by_id` text NOT NULL,
	`queued_at` integer NOT NULL,
	`sent_at` integer,
	`delivered_at` integer,
	`opened_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_delivery` ON `document_delivery` (`organization_id`,`doc_type`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_delivery_status` ON `document_delivery` (`organization_id`,`status`,`queued_at`);--> statement-breakpoint
CREATE TABLE `invoice` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`counterparty_id` text NOT NULL,
	`document_no` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`supersedes_id` text,
	`credit_note_for_id` text,
	`is_credit_note` integer DEFAULT false NOT NULL,
	`issue_date` text NOT NULL,
	`total_amount` integer NOT NULL,
	`counterparty_name` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`due_date` text NOT NULL,
	`subtotal_amount` integer NOT NULL,
	`tax_amount` integer NOT NULL,
	`is_qualified_invoice` integer NOT NULL,
	`issuer_snapshot` text NOT NULL,
	`counterparty_snapshot` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`pdf_storage_key` text,
	`pdf_sha256` text,
	`payload_sha256` text,
	`confirmed_at` integer,
	`confirmed_by_id` text,
	`sent_at` integer,
	`paid_at` integer,
	`voided_at` integer,
	`void_reason` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inv` ON `invoice` (`organization_id`,`document_no`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_inv_search` ON `invoice` (`organization_id`,`issue_date`,`total_amount`);--> statement-breakpoint
CREATE INDEX `idx_inv_party` ON `invoice` (`organization_id`,`counterparty_name`);--> statement-breakpoint
CREATE INDEX `idx_inv_status` ON `invoice` (`organization_id`,`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `idx_inv_party_id` ON `invoice` (`organization_id`,`counterparty_id`,`issue_date`);--> statement-breakpoint
CREATE TABLE `invoice_line` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`property_id` text,
	`item_code` text NOT NULL,
	`description` text NOT NULL,
	`service_date_from` text,
	`service_date_to` text,
	`quantity` real NOT NULL,
	`unit` text DEFAULT '室' NOT NULL,
	`unit_price` integer NOT NULL,
	`amount` integer NOT NULL,
	`tax_rate` integer NOT NULL,
	`is_reduced_rate` integer DEFAULT false NOT NULL,
	`source_ref` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inv_line` ON `invoice_line` (`organization_id`,`invoice_id`,`line_no`);--> statement-breakpoint
CREATE INDEX `idx_inv_line_invoice` ON `invoice_line` (`organization_id`,`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoice_tax_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`tax_rate` integer NOT NULL,
	`is_reduced_rate` integer NOT NULL,
	`subtotal_amount` integer NOT NULL,
	`tax_amount` integer NOT NULL,
	`total_amount` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tax_sum` ON `invoice_tax_summary` (`organization_id`,`invoice_id`,`tax_rate`,`is_reduced_rate`);--> statement-breakpoint
CREATE TABLE `pricing_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`counterparty_id` text NOT NULL,
	`property_id` text,
	`room_type_id` text,
	`task_type` text,
	`item_code` text NOT NULL,
	`unit_price` integer NOT NULL,
	`tax_rate` integer DEFAULT 10 NOT NULL,
	`is_reduced_rate` integer DEFAULT false NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`priority` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pricing` ON `pricing_rule` (`organization_id`,`counterparty_id`,`item_code`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_pricing_property` ON `pricing_rule` (`organization_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`invoice_id` text,
	`counterparty_id` text NOT NULL,
	`document_no` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`issue_date` text NOT NULL,
	`total_amount` integer NOT NULL,
	`counterparty_name` text NOT NULL,
	`received_amount` integer NOT NULL,
	`received_date` text NOT NULL,
	`payment_method` text NOT NULL,
	`purpose_text` text DEFAULT '清掃業務委託料として' NOT NULL,
	`tax_summary` text NOT NULL,
	`is_qualified_invoice` integer NOT NULL,
	`issuer_snapshot` text NOT NULL,
	`counterparty_snapshot` text NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`pdf_storage_key` text,
	`pdf_sha256` text,
	`sent_at` integer,
	`voided_at` integer,
	`void_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_rcp` ON `receipt` (`organization_id`,`document_no`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_rcp_search` ON `receipt` (`organization_id`,`issue_date`,`total_amount`);--> statement-breakpoint
CREATE INDEX `idx_rcp_party` ON `receipt` (`organization_id`,`counterparty_name`);--> statement-breakpoint
CREATE INDEX `idx_rcp_invoice` ON `receipt` (`organization_id`,`invoice_id`);